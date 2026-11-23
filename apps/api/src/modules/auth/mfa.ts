import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../../config.js";
import type { IdentityDb } from "../../db/sql.js";
import { conflict, forbidden, serviceUnavailable, unauthorized, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { hashPassword, verifyPassword } from "../identity/password.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function fromBase32(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw validationError("Invalid base32 TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (6 digits, 30-second step, HMAC-SHA1). */
export function computeTotpCode(secretBase32: string, timestampMs = Date.now(), stepOffset = 0): string {
  const key = fromBase32(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / 30) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** The time step (counter) whose code matches, within +/-1 step of the clock, or null. */
export function matchTotpStep(secretBase32: string, code: string, timestampMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const target = Buffer.from(code, "utf8");
  let matched: number | null = null;
  for (const offset of [-1, 0, 1]) {
    const expected = Buffer.from(computeTotpCode(secretBase32, timestampMs, offset), "utf8");
    if (timingSafeEqual(target, expected)) matched = Math.floor(timestampMs / 1000 / 30) + offset;
  }
  return matched;
}

export function verifyTotpCode(secretBase32: string, code: string, timestampMs = Date.now()): boolean {
  return matchTotpStep(secretBase32, code, timestampMs) !== null;
}

/**
 * Single-use enforcement (RFC 6238 5.2): atomically advance the factor's last accepted time step. Returns false
 * when this step (or a later one) was already accepted, i.e. the code is a replay. Of two concurrent
 * presentations of one code exactly one wins.
 */
async function claimTotpStep(db: IdentityDb, factorId: string, step: number): Promise<boolean> {
  const res = await db.query(
    `UPDATE mfa_factors SET last_used_step = $2, failed_count = 0, failed_window_start = NULL
      WHERE id = $1 AND (last_used_step IS NULL OR last_used_step < $2) RETURNING id`,
    [factorId, step],
  );
  return (res.rowCount ?? 0) === 1;
}

/** Legacy key (migration 085): derived from the session HMAC key. Kept only to read factors enrolled before 088. */
function legacyAesKey(config: AppConfig): Buffer {
  return createHash("sha256").update(`mfa-totp:${config.sessionMintHmacKey}`).digest();
}

/** Dedicated key (088): independent of the session HMAC key so rotating one never orphans the other. */
function dedicatedAesKey(config: AppConfig): Buffer | null {
  return config.mfaEncryptionKey ? createHash("sha256").update(`mfa-totp:v2:${config.mfaEncryptionKey}`).digest() : null;
}

const V2 = "v2:";

export function encryptSecret(config: AppConfig, plaintext: string): string {
  const dedicated = dedicatedAesKey(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dedicated ?? legacyAesKey(config), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${dedicated ? V2 : ""}${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

/**
 * A factor that cannot be read (wrong/missing key, tampered or malformed ciphertext) is a server-side data problem, not
 * a wrong code: it must be a controlled 503 (never a raw crypto error -> 500) and never a 401, because 401s are counted
 * as failed attempts against the user's throttle.
 */
function unreadableFactor(reason: string): ReturnType<typeof serviceUnavailable> {
  return serviceUnavailable(`MFA verification is temporarily unavailable (${reason}). Contact an administrator.`, 30);
}

export function decryptSecret(config: AppConfig, stored: string): string {
  const isV2 = stored.startsWith(V2);
  const packed = isV2 ? stored.slice(V2.length) : stored;
  const [ivB64, tagB64, encB64, extra] = packed.split(".");
  if (!ivB64 || !tagB64 || !encB64 || extra !== undefined) throw unreadableFactor("malformed factor");
  const key = isV2 ? dedicatedAesKey(config) : legacyAesKey(config);
  if (!key) throw unreadableFactor("encryption key not configured");
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw unreadableFactor("malformed factor");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(encB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw unreadableFactor("factor could not be decrypted");
  }
}

/** After a successful use of a factor stored under the legacy key, move it to the dedicated key. */
async function upgradeSecretIfLegacy(db: IdentityDb, config: AppConfig, factorId: string, stored: string, secret: string): Promise<void> {
  if (stored.startsWith(V2) || !config.mfaEncryptionKey) return;
  await db.query(`UPDATE mfa_factors SET secret_encrypted = $2 WHERE id = $1`, [factorId, encryptSecret(config, secret)]);
}

export async function enrollTotp(
  db: IdentityDb,
  config: AppConfig,
  input: { userId: string; accountLabel: string; ip?: string | null },
): Promise<{ factorId: string; secret: string; otpauthUri: string; recoveryCodes: string[] }> {
  const existing = await db.query<{ id: string; verified_at: Date | null }>(
    `SELECT id, verified_at FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`,
    [input.userId],
  );
  if (existing.rows[0]?.verified_at) {
    throw conflict("An active TOTP factor is already enrolled");
  }
  if (existing.rows[0]) {
    await db.query(`UPDATE mfa_factors SET disabled_at = now() WHERE id = $1`, [existing.rows[0].id]);
  }
  const secret = toBase32(randomBytes(20));
  const encrypted = encryptSecret(config, secret);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO mfa_factors (user_id, kind, secret_encrypted) VALUES ($1, 'totp', $2) RETURNING id`,
    [input.userId, encrypted],
  );
  const recoveryCodes: string[] = [];
  await db.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [
    input.userId,
  ]);
  for (let i = 0; i < 8; i++) {
    const code = `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`;
    recoveryCodes.push(code);
    const hash = await hashPassword(code);
    await db.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [input.userId, hash]);
  }
  await recordSecurityEvent(db, {
    eventType: "auth.mfa.enrolled",
    actorUserId: input.userId,
    detail: { factorId: inserted.rows[0]!.id, kind: "totp" },
    ip: input.ip,
  });
  const issuer = encodeURIComponent("FigBloom");
  const label = encodeURIComponent(input.accountLabel);
  return {
    factorId: inserted.rows[0]!.id,
    secret,
    otpauthUri: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}`,
    recoveryCodes,
  };
}

export async function verifyAndActivateTotp(
  db: IdentityDb,
  config: AppConfig,
  input: { userId: string; sessionId: string; code: string; ip?: string | null },
): Promise<{ verified: true }> {
  const factor = await db.query<{ id: string; secret_encrypted: string; verified_at: Date | null }>(
    `SELECT id, secret_encrypted, verified_at FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`,
    [input.userId],
  );
  const row = factor.rows[0];
  if (!row) throw validationError("No pending MFA factor found");
  const secret = decryptSecret(config, row.secret_encrypted);
  const step = matchTotpStep(secret, input.code);
  if (step === null || !(await claimTotpStep(db, row.id, step))) {
    await recordSecurityEvent(db, {
      eventType: "auth.mfa.failed",
      actorUserId: input.userId,
      detail: { factorId: row.id, stage: "verify" },
      ip: input.ip,
    });
    throw unauthorized("Invalid MFA code");
  }
  if (!row.verified_at) {
    await db.query(`UPDATE mfa_factors SET verified_at = now() WHERE id = $1`, [row.id]);
  }
  await upgradeSecretIfLegacy(db, config, row.id, row.secret_encrypted, secret);
  await db.query(`SELECT public.auth_stamp_session_mfa($1)`, [input.sessionId]);
  await recordSecurityEvent(db, {
    eventType: "auth.mfa.verified",
    actorUserId: input.userId,
    detail: { factorId: row.id, stage: "verify" },
    ip: input.ip,
  });
  return { verified: true };
}

export async function challengeMfa(
  db: IdentityDb,
  config: AppConfig,
  input: { userId: string; sessionId: string; code?: string; recoveryCode?: string; ip?: string | null },
): Promise<{ verified: true; method: "totp" | "recovery_code" }> {
  const factor = await db.query<{ id: string; secret_encrypted: string; verified_at: Date | null }>(
    `SELECT id, secret_encrypted, verified_at FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`,
    [input.userId],
  );
  const row = factor.rows[0];
  if (!row || !row.verified_at) throw validationError("No active MFA factor enrolled");

  if (input.code) {
    const secret = decryptSecret(config, row.secret_encrypted);
    const step = matchTotpStep(secret, input.code);
    if (step === null || !(await claimTotpStep(db, row.id, step))) {
      await recordSecurityEvent(db, {
        eventType: "auth.mfa.failed",
        actorUserId: input.userId,
        detail: { factorId: row.id, method: "totp" },
        ip: input.ip,
      });
      throw unauthorized("Invalid MFA code");
    }
    await upgradeSecretIfLegacy(db, config, row.id, row.secret_encrypted, secret);
    await db.query(`SELECT public.auth_stamp_session_mfa($1)`, [input.sessionId]);
    await recordSecurityEvent(db, {
      eventType: "auth.mfa.verified",
      actorUserId: input.userId,
      detail: { factorId: row.id, method: "totp" },
      ip: input.ip,
    });
    return { verified: true, method: "totp" };
  }

  if (input.recoveryCode) {
    const codes = await db.query<{ id: string; code_hash: string }>(
      `SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`,
      [input.userId],
    );
    for (const c of codes.rows) {
      if (await verifyPassword(input.recoveryCode, c.code_hash)) {
        await db.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1`, [c.id]);
        await db.query(`UPDATE mfa_factors SET failed_count = 0, failed_window_start = NULL WHERE id = $1`, [row.id]);
        await db.query(`SELECT public.auth_stamp_session_mfa($1)`, [input.sessionId]);
        await recordSecurityEvent(db, {
          eventType: "auth.mfa.verified",
          actorUserId: input.userId,
          detail: { factorId: row.id, method: "recovery_code" },
          ip: input.ip,
        });
        return { verified: true, method: "recovery_code" };
      }
    }
    await recordSecurityEvent(db, {
      eventType: "auth.mfa.failed",
      actorUserId: input.userId,
      detail: { factorId: row.id, method: "recovery_code" },
      ip: input.ip,
    });
    throw unauthorized("Invalid recovery code");
  }
  throw validationError("Provide code or recovery_code");
}

export async function disableTotp(
  db: IdentityDb,
  config: AppConfig,
  input: { userId: string; code: string; ip?: string | null },
): Promise<{ disabled: true }> {
  const factor = await db.query<{ id: string; secret_encrypted: string }>(
    `SELECT id, secret_encrypted FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`,
    [input.userId],
  );
  const row = factor.rows[0];
  if (!row) throw forbidden("No active MFA factor");
  const secret = decryptSecret(config, row.secret_encrypted);
  const step = matchTotpStep(secret, input.code);
  if (step === null || !(await claimTotpStep(db, row.id, step))) throw unauthorized("Invalid MFA code");
  await db.query(`UPDATE mfa_factors SET disabled_at = now() WHERE id = $1`, [row.id]);
  await db.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [
    input.userId,
  ]);
  // a mandatory account that disables its factor loses assurance on every session at once
  await db.query(`SELECT public.mfa_clear_own_assurance()`);
  await recordSecurityEvent(db, {
    eventType: "auth.mfa.disabled",
    actorUserId: input.userId,
    detail: { factorId: row.id },
    ip: input.ip,
  });
  return { disabled: true };
}

/** New recovery codes after proving possession of the device (the previous set is voided). */
export async function regenerateRecoveryCodes(
  db: IdentityDb,
  config: AppConfig,
  input: { userId: string; code: string; ip?: string | null },
): Promise<{ recoveryCodes: string[] }> {
  const factor = await db.query<{ id: string; secret_encrypted: string; verified_at: Date | null }>(
    `SELECT id, secret_encrypted, verified_at FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL`,
    [input.userId],
  );
  const row = factor.rows[0];
  if (!row || !row.verified_at) throw validationError("No active MFA factor enrolled");
  const secret = decryptSecret(config, row.secret_encrypted);
  const step = matchTotpStep(secret, input.code);
  if (step === null || !(await claimTotpStep(db, row.id, step))) throw unauthorized("Invalid MFA code");
  await db.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [input.userId]);
  const recoveryCodes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const code = `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`;
    recoveryCodes.push(code);
    await db.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [input.userId, await hashPassword(code)]);
  }
  await recordSecurityEvent(db, {
    eventType: "auth.mfa.recovery_regenerated",
    actorUserId: input.userId,
    detail: { factorId: row.id },
    ip: input.ip,
  });
  return { recoveryCodes };
}
