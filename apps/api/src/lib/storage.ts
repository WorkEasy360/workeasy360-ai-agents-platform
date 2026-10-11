import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** S3 in AWS (IAM role credentials), S3Mock locally (S3_ENDPOINT + path-style). */
let client: S3Client | undefined;

function s3(): S3Client {
  client ??= new S3Client({
    region: process.env.AWS_REGION ?? "ap-south-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    // S3Mock accepts any credentials; real AWS uses the task role.
    ...(process.env.S3_ENDPOINT ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
  });
  return client;
}

const bucket = () => {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error("S3_BUCKET is not configured");
  return b;
};

export function documentKey(orgId: string, kbId: string, documentId: string) {
  return `org/${orgId}/kb/${kbId}/${documentId}`;
}

export function knowledgeBasePrefix(orgId: string, kbId: string) {
  return `org/${orgId}/kb/${kbId}/`;
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, ...(process.env.S3_ENDPOINT
        ? {}
        : { ServerSideEncryption: "aws:kms", SSEKMSKeyId: process.env.KMS_KEY_ID }) }));
}

export async function getObject(key: string): Promise<Buffer> {
  const out = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return Buffer.from(await out.Body!.transformToByteArray());
}

export async function deleteObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Deletes every object under a prefix (used when an organization is deleted). Returns the count. */
export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) {
      await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}
