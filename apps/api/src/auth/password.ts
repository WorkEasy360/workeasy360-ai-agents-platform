import { hash, verify } from "@node-rs/argon2";
import { verifyPassword as verifyScrypt } from "better-auth/crypto";

/**
 * Password hashing: Argon2id with OWASP's recommended minimum (19 MiB memory, 2 iterations,
 * 1 lane). Accounts created before the switch have Better Auth's scrypt "salt:hash" format;
 * those still verify and are upgraded to Argon2id on the next successful sign-in.
 */
// algorithm 2 = Algorithm.Argon2id (a const enum, which isolatedModules can't import).
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword({ hash: stored, password }: { hash: string; password: string }): Promise<boolean> {
  if (stored.startsWith("$argon2")) return verify(stored, password).catch(() => false);
  return verifyScrypt({ hash: stored, password });
}

/** True when a stored hash should be replaced (older algorithm or weaker parameters). */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith(`$argon2id$v=19$m=${ARGON2.memoryCost},t=${ARGON2.timeCost},p=${ARGON2.parallelism}$`);
}
