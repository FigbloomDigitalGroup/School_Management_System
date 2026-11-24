import { apiClient } from "./client";
import type { components } from "./schema";

/**
 * The sign-in calls of apps/api, one function each (FIG-1890). Screens on an API build use these for the parts that
 * have no Supabase equivalent (two-step verification, the current-password change); session.ts uses them for the rest.
 */

export type ApiUser = components["schemas"]["PublicUser"];
export type ApiLogin = components["schemas"]["LoginResponse"];
export type ApiMe = components["schemas"]["Me"];

/** Signs in with an email and password and keeps the session. A wrong password is a 401 ApiError and ends nothing. */
export async function apiLoginWithEmail(email: string, password: string): Promise<ApiLogin> {
  const c = apiClient();
  const res = await c.post("/v1/auth/login/email", { body: { email, password }, auth: false, tenantId: null });
  c.store.set({ token: res.token, expiresAt: res.expiresAt, userId: res.user.id });
  return res;
}

/** Signs in with a school's id (its uuid, not its slug), a login ID and a password. */
export async function apiLoginWithLoginId(tenantId: string, loginId: string, password: string): Promise<ApiLogin> {
  const c = apiClient();
  const res = await c.post("/v1/auth/login/login-id", { body: { tenantId, loginId, password }, auth: false, tenantId: null });
  c.store.set({ token: res.token, expiresAt: res.expiresAt, userId: res.user.id });
  return res;
}

/** Who is signed in, their schools and their role. Allowed before two-step verification is done. */
export function apiMe(): Promise<ApiMe> {
  return apiClient().get("/v1/auth/me", { tenantId: null });
}

/** Ends this session on the server and forgets it here. The server's answer does not matter: the person is signed out either way. */
export async function apiLogout(): Promise<void> {
  const c = apiClient();
  try {
    if (c.session()) await c.post("/v1/auth/logout", { tenantId: null, keepSessionOn401: true, timeoutMs: 5_000 });
  } catch {
    // Already ended, offline or slow: nothing more to do than forget it.
  } finally {
    c.store.clear();
  }
}

/** Confirms the password for the sensitive-action window (default 300 s). A wrong password is a 401 that keeps the session. */
export function apiReauth(password: string): Promise<{ ok: boolean; valid_for_seconds: number }> {
  return apiClient().post("/v1/auth/reauth", { body: { password }, tenantId: null, keepSessionOn401: true });
}

/** The server's password rule (apps/api passwordPolicy.ts): at least 10 characters, with letters and numbers. */
export const API_PASSWORD_MIN_LENGTH = 10;

/** What is wrong with a new password under the server's rule, in words for a person; null when it passes. */
export function apiPasswordProblem(password: string): string | null {
  if (password.length < API_PASSWORD_MIN_LENGTH) return `The new password needs at least ${API_PASSWORD_MIN_LENGTH} characters.`;
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "The new password needs letters and numbers.";
  return null;
}

/** Changes the password. Allowed while must_change_password is set; the server ends the person's other sessions and keeps this one. */
export function apiChangePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; user: ApiUser }> {
  return apiClient().post("/v1/auth/password/change", { body: { currentPassword, newPassword }, tenantId: null, keepSessionOn401: true });
}

// ---------------------------------------------------------------- two-step verification (TOTP)
// The server describes these answers loosely, so the shapes below are written from apps/api/src/http/routes/auth.ts.

/** Where the sign-in stands on two-step verification. `next` is what the person has to do before anything else works. */
export interface MfaStatus {
  required: boolean;
  assured: boolean;
  enrolled: boolean;
  enforcement: string;
  next: "none" | "enroll" | "challenge";
}

export interface MfaEnrolment {
  factorId: string;
  /** The base32 key, for typing into an authenticator app. */
  secret: string;
  /** The otpauth:// address an authenticator app opens (or a QR code of it). */
  otpauthUri: string;
  /** Shown once. The person keeps them for a lost phone. */
  recoveryCodes: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseMfaStatus(v: unknown): MfaStatus {
  if (!isRecord(v)) throw new Error("The server's two-step status was not understood.");
  const next = v.next === "enroll" || v.next === "challenge" ? v.next : "none";
  return {
    required: v.required === true,
    assured: v.assured === true,
    enrolled: v.enrolled === true,
    enforcement: typeof v.enforcement === "string" ? v.enforcement : "unknown",
    next,
  };
}

export function parseMfaEnrolment(v: unknown): MfaEnrolment {
  if (
    !isRecord(v) || typeof v.factorId !== "string" || typeof v.secret !== "string" || typeof v.otpauthUri !== "string" ||
    !Array.isArray(v.recoveryCodes) || !v.recoveryCodes.every((c) => typeof c === "string")
  ) throw new Error("The server's two-step enrolment was not understood.");
  return { factorId: v.factorId, secret: v.secret, otpauthUri: v.otpauthUri, recoveryCodes: v.recoveryCodes as string[] };
}

export async function apiMfaStatus(): Promise<MfaStatus> {
  return parseMfaStatus(await apiClient().get("/v1/auth/mfa/status", { tenantId: null }));
}

/** Starts enrolment: a new key and eight recovery codes. Needs the password confirmed recently (the client asks through the reauth handler). */
export async function apiMfaEnroll(): Promise<MfaEnrolment> {
  return parseMfaEnrolment(await apiClient().post("/v1/auth/mfa/totp/enroll", { tenantId: null }));
}

/** Finishes enrolment with the first code from the authenticator app. A wrong code is a 401 that keeps the session. */
export async function apiMfaVerify(code: string): Promise<void> {
  await apiClient().post("/v1/auth/mfa/totp/verify", { body: { code }, tenantId: null, keepSessionOn401: true });
}

/** Answers the sign-in challenge with a 6-digit code, or a recovery code. */
export async function apiMfaChallenge(answer: { code: string } | { recoveryCode: string }): Promise<void> {
  const body = "code" in answer ? { code: answer.code } : { recovery_code: answer.recoveryCode };
  await apiClient().post("/v1/auth/mfa/challenge", { body, tenantId: null, keepSessionOn401: true });
}

/** Replaces the recovery codes. Needs a fresh 6-digit TOTP code and recent password confirmation (reauth). */
export async function apiMfaRegenerateRecoveryCodes(code: string): Promise<string[]> {
  const res = await apiClient().post("/v1/auth/mfa/recovery-codes/regenerate", {
    body: { code },
    tenantId: null,
    keepSessionOn401: true,
  });
  if (!isRecord(res) || !Array.isArray(res.recoveryCodes) || !res.recoveryCodes.every((c) => typeof c === "string")) {
    throw new Error("The server's recovery codes response was not understood.");
  }
  return res.recoveryCodes as string[];
}

/**
 * Turns two-step verification off. Needs a fresh 6-digit code and a recent password confirmation (reauth); a wrong code is a 401
 * that keeps the session. The server then drops the two-step assurance of every session of the person.
 */
export async function apiMfaDisable(code: string): Promise<void> {
  await apiClient().post("/v1/auth/mfa/disable", { body: { code }, tenantId: null, keepSessionOn401: true });
}

/**
 * Asks for a password-reset e-mail. The server answers the same whether or not the address has an account
 * (no enumeration), so this resolves either way; only throttling and outages throw.
 */
export async function apiRequestPasswordReset(email: string): Promise<void> {
  await apiClient().post("/v1/auth/password-reset/request", {
    body: { email: email.trim() },
    auth: false,
    tenantId: null,
  });
}

/**
 * Sets a new password with the token from a reset e-mail. The token works once and for 30 minutes; the server
 * signs that account out everywhere. An invalid, used or expired token is a 401 ApiError.
 */
export async function apiCompletePasswordReset(input: { token: string; password: string }): Promise<void> {
  await apiClient().post("/v1/auth/password-reset/complete", {
    body: { token: input.token, password: input.password },
    auth: false,
    tenantId: null,
    keepSessionOn401: true,
  });
}

export interface AcceptInvitationResult {
  status: "accepted";
  tenantId: string | null;
}

/**
 * Accepts an invitation token (FIG-1890). New accounts set a password without a bearer token;
 * existing accounts send their current session token.
 */
export async function apiAcceptInvitation(input: {
  token: string;
  password: string;
  fullName?: string;
}): Promise<AcceptInvitationResult> {
  const c = apiClient();
  const body: { token: string; password: string; full_name?: string } = {
    token: input.token,
    password: input.password,
  };
  if (input.fullName?.trim()) body.full_name = input.fullName.trim();
  const res = await c.post("/v1/invitations/accept", {
    body,
    auth: Boolean(c.session()),
    tenantId: null,
    keepSessionOn401: true,
  });
  return { status: res.status, tenantId: res.tenant_id };
}
