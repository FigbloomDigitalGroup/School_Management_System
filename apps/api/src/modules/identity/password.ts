import * as nodeCrypto from "node:crypto";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing (centralised). New hashes are Argon2id (OWASP first-choice parameters m=47104 KiB, t=1, p=1,
 * benchmarked ~45 ms on the development machine); the legacy scrypt format stays VERIFIABLE until every hash has
 * migrated lazily at login (auth/service.ts -> auth_rehash_password, migration 068). There is no silent fallback to a
 * weaker algorithm: if this runtime lacks crypto.argon2 (Node < 24.7) hashing throws.
 *
 * Resource exhaustion: each verification holds `m` KiB for its duration and runs on the libuv pool (4 threads by
 * default), so concurrent memory is bounded; attempts are bounded by the login token buckets. Parameters read from a
 * stored hash are capped before use so a hostile or corrupt row cannot demand unbounded memory.
 */
type Argon2Fn = (
  algorithm: "argon2id",
  parameters: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
) => Promise<Buffer>;
type ScryptFn = (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// @types/node 22 does not declare crypto.argon2 (Node >= 24.7); resolved at runtime, never silently replaced.
const argon2Cb = (nodeCrypto as unknown as { argon2?: (...a: never[]) => void }).argon2;
const argon2 = (typeof argon2Cb === "function" ? promisify(argon2Cb as never) : null) as unknown as Argon2Fn | null;
const scrypt = promisify(scryptCb) as unknown as ScryptFn;

export const ARGON2_PARAMS = { memory: 47104, passes: 1, parallelism: 1, tagLength: 32, saltBytes: 16 } as const;
const MAX_MEMORY = 262_144; // 256 MiB cap on parameters read from storage
const MAX_PASSES = 10;
const MAX_PARALLELISM = 4;

const toB64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");
const fromB64 = (s: string) => Buffer.from(s, "base64");

function requireArgon2(): Argon2Fn {
  if (!argon2) throw new Error("crypto.argon2 is unavailable in this runtime (Node >= 24.7 required)");
  return argon2;
}

/** Hash a password with Argon2id. Never store plaintext. */
export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(ARGON2_PARAMS.saltBytes);
  const tag = await requireArgon2()("argon2id", {
    message: Buffer.from(password, "utf8"),
    nonce,
    parallelism: ARGON2_PARAMS.parallelism,
    tagLength: ARGON2_PARAMS.tagLength,
    memory: ARGON2_PARAMS.memory,
    passes: ARGON2_PARAMS.passes,
  });
  return `$argon2id$v=19$m=${ARGON2_PARAMS.memory},t=${ARGON2_PARAMS.passes},p=${ARGON2_PARAMS.parallelism}$${toB64(nonce)}$${toB64(tag)}`;
}

/** Legacy format, kept ONLY so the migration path can be tested with realistic pre-migration hashes. */
export async function legacyScryptHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/** Constant-time verify of either format. Returns false for malformed hashes. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (encoded.startsWith("$argon2id$")) return verifyArgon2id(password, encoded);
  if (encoded.startsWith("scrypt$")) return verifyScrypt(password, encoded);
  return false;
}

async function verifyArgon2id(password: string, encoded: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(encoded);
  if (!m) return false;
  const memory = Number(m[1]);
  const passes = Number(m[2]);
  const parallelism = Number(m[3]);
  if (memory < 8 * parallelism || memory > MAX_MEMORY || passes < 1 || passes > MAX_PASSES || parallelism < 1 || parallelism > MAX_PARALLELISM) {
    return false;
  }
  const nonce = fromB64(m[4]!);
  const expected = fromB64(m[5]!);
  if (nonce.length < 8 || expected.length < 16 || expected.length > 64) return false;
  const tag = await requireArgon2()("argon2id", {
    message: Buffer.from(password, "utf8"),
    nonce,
    parallelism,
    tagLength: expected.length,
    memory,
    passes,
  });
  return tag.length === expected.length && timingSafeEqual(tag, expected);
}

async function verifyScrypt(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || n > 2 ** 17 || r > 16 || p > 8) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  const derived = await scrypt(password, salt, expected.length, { N: n, r, p });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when the stored hash is not Argon2id at the current parameters (migrate it after a successful verification). */
export function passwordNeedsRehash(encoded: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded);
  if (!m) return true;
  return Number(m[1]) < ARGON2_PARAMS.memory || Number(m[2]) < ARGON2_PARAMS.passes || Number(m[3]) < ARGON2_PARAMS.parallelism;
}
