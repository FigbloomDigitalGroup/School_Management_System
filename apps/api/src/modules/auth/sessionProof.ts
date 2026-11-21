import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../../config.js";

/** Microsecond UTC text matching PostgreSQL to_char used in migration 014 proofs. */
export function proofTimestampUtc(date: Date): string {
  const iso = date.toISOString(); // milliseconds
  // Expand to microseconds (pad with 000) for stable cross-language payloads.
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})Z$/.exec(iso);
  if (!m) throw new Error("invalid Date for session proof");
  return `${m[1]}.${m[2]}000Z`;
}

export function sessionMintHmacKey(config: AppConfig): string {
  const key = config.sessionMintHmacKey;
  if (!key || key.length < 32) {
    throw new Error("SESSION_MINT_HMAC_KEY is required (at least 32 characters)");
  }
  return key;
}

export function signSessionProof(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Test helper: constant-time compare for documentation / unit checks. */
export function proofMacEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function newProofNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function buildMintPayload(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  issuedAt: Date;
  nonce: string;
  mintedBy: "login" | "refresh";
  actorUserId: string;
  activeTenantId: string | null;
  activeOrganizationId: string | null;
}): string {
  return [
    "v1",
    "mint",
    input.userId,
    input.tokenHash,
    proofTimestampUtc(input.expiresAt),
    proofTimestampUtc(input.issuedAt),
    input.nonce,
    input.mintedBy,
    input.actorUserId,
    input.activeTenantId ?? "-",
    input.activeOrganizationId ?? "-",
  ].join("|");
}

export function buildRevokePayload(input: {
  sessionId: string;
  issuedAt: Date;
  nonce: string;
  actorUserId: string;
}): string {
  return [
    "v1",
    "revoke",
    input.sessionId,
    proofTimestampUtc(input.issuedAt),
    input.nonce,
    input.actorUserId,
  ].join("|");
}

export function buildRevokeAllPayload(input: {
  userId: string;
  keepSessionId: string | null;
  issuedAt: Date;
  nonce: string;
  actorUserId: string;
}): string {
  return [
    "v1",
    "revoke_all",
    input.userId,
    input.keepSessionId ?? "-",
    proofTimestampUtc(input.issuedAt),
    input.nonce,
    input.actorUserId,
  ].join("|");
}

export function buildSetTenantPayload(input: {
  sessionId: string;
  tenantId: string;
  organizationId: string;
  issuedAt: Date;
  nonce: string;
  actorUserId: string;
}): string {
  return [
    "v1",
    "set_tenant",
    input.sessionId,
    input.tenantId,
    input.organizationId,
    proofTimestampUtc(input.issuedAt),
    input.nonce,
    input.actorUserId,
  ].join("|");
}

/**
 * Readiness self-test (migration 015 auth_session_hmac_status). The database verifies
 * exactly this payload shape against its active key(s); nothing is consumed.
 */
export function buildSelftestPayload(nonce: string): string {
  return `v1|selftest|${nonce}`;
}

export type SessionHmacStatus = "ok" | "mismatch" | "no_secret" | "invalid";

/** True for the documented local/test development key, which must never run in staging/production. */
export function isWellKnownLocalKey(key: string | undefined): boolean {
  return key === LOCAL_SESSION_MINT_HMAC_KEY;
}

/** Default local/test key — never use outside local/test. */
export const LOCAL_SESSION_MINT_HMAC_KEY =
  "figbloom-local-session-mint-hmac-key-do-not-use-in-prod";
