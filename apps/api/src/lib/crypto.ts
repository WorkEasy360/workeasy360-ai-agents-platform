import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

/**
 * Envelope encryption for tenant secrets (tool credentials, BYOK model keys).
 * Each secret gets its own 256-bit data key. The data key is encrypted with AWS KMS
 * (KMS_KEY_ID) in AWS, or with LOCAL_MASTER_KEY in local development.
 * Plaintext secrets exist only in memory, only for the duration of a call.
 */

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedDataKey: Buffer;
  keyVersion: number;
}

const KEY_VERSION = 1;
let kms: KMSClient | undefined;

function localMasterKey(): Buffer {
  const raw = process.env.LOCAL_MASTER_KEY;
  if (!raw) throw new Error("Set KMS_KEY_ID (AWS) or LOCAL_MASTER_KEY (local) to store secrets");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("LOCAL_MASTER_KEY must be 32 bytes, base64-encoded");
  return key;
}

function aesEncrypt(key: Buffer, plaintext: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

function aesDecrypt(key: Buffer, iv: Buffer, ciphertext: Buffer, authTag: Buffer): Buffer {
  // Fixed 16-byte tag: without it, a forged ciphertext with a truncated tag could be accepted.
  if (authTag.length !== 16) throw new Error("Invalid authentication tag");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function newDataKey(): Promise<{ plaintext: Buffer; encrypted: Buffer }> {
  const keyId = process.env.KMS_KEY_ID;
  if (keyId) {
    kms ??= new KMSClient({ region: process.env.AWS_REGION });
    const out = await kms.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: "AES_256" }));
    return { plaintext: Buffer.from(out.Plaintext!), encrypted: Buffer.from(out.CiphertextBlob!) };
  }
  const plaintext = randomBytes(32);
  const wrapped = aesEncrypt(localMasterKey(), plaintext);
  // Local format: iv(12) | tag(16) | ciphertext
  return { plaintext, encrypted: Buffer.concat([wrapped.iv, wrapped.authTag, wrapped.ciphertext]) };
}

async function unwrapDataKey(encrypted: Buffer): Promise<Buffer> {
  if (process.env.KMS_KEY_ID) {
    kms ??= new KMSClient({ region: process.env.AWS_REGION });
    const out = await kms.send(new DecryptCommand({ CiphertextBlob: encrypted }));
    return Buffer.from(out.Plaintext!);
  }
  return aesDecrypt(localMasterKey(), encrypted.subarray(0, 12), encrypted.subarray(28), encrypted.subarray(12, 28));
}

export async function encryptSecret(plaintext: string): Promise<EncryptedSecret> {
  const dataKey = await newDataKey();
  try {
    const { iv, ciphertext, authTag } = aesEncrypt(dataKey.plaintext, Buffer.from(plaintext, "utf8"));
    return { ciphertext, iv, authTag, encryptedDataKey: dataKey.encrypted, keyVersion: KEY_VERSION };
  } finally {
    dataKey.plaintext.fill(0);
  }
}

export async function decryptSecret(secret: EncryptedSecret): Promise<string> {
  const dataKey = await unwrapDataKey(secret.encryptedDataKey);
  try {
    return aesDecrypt(dataKey, secret.iv, secret.ciphertext, secret.authTag).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/** Last 4 characters for display, never more. */
export function last4(secret: string): string {
  return secret.length > 8 ? secret.slice(-4) : "";
}
