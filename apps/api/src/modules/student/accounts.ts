import { randomInt } from "node:crypto";
import type { Tx } from "../../db/sql.js";
import { AppError, conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { hashPassword } from "../identity/password.js";
import { assertPasswordPolicy } from "../identity/passwordPolicy.js";

/**
 * Student accounts: the school office makes, resets and revokes a learner's login (docs/STUDENT-ACCOUNTS.md, migration 110).
 * Every rule that protects the login (who may act, one live login per learner, collision-safe ST- numbers, forced change at
 * first sign-in, sessions ended on reset and revoke) is enforced in the SECURITY DEFINER functions; this module makes the
 * one-time password, hashes it, and maps the database outcomes onto safe API errors. The clear password is returned to the
 * caller once and is never stored, logged or audited.
 */

/** Look-alike characters (0/O, 1/l/I) are left out: the office reads the password off the screen to the learner. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ONE_TIME_PASSWORD_LENGTH = 12;

/** A random one-time password that meets the password policy (letters and digits, at least 10 characters). */
export function oneTimePassword(): string {
  for (;;) {
    let out = "";
    for (let i = 0; i < ONE_TIME_PASSWORD_LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
    try {
      assertPasswordPolicy(out);
      return out;
    } catch {
      // no letter or no digit in this draw: draw again
    }
  }
}

function mapDb(err: unknown): never {
  if (err instanceof AppError) throw err;
  const code = (err as { code?: string } | null)?.code;
  if (code === "42501") throw forbidden("Only the school office can manage a learner's login");
  if (code === "23505") throw conflict("This learner already has a login; reset its password or revoke it first");
  if (code === "55000") throw conflict("The learner is archived or the login is disabled");
  if (code === "54000") throw conflict("This school has used every student login number (ST-0001 to ST-9999)");
  if (code === "P0002") throw notFound("Learner not found");
  if (code === "22023") throw validationError("Invalid request");
  throw err;
}

export interface StudentAccountIssued {
  learner_id: string;
  user_id: string;
  login_id: string;
  must_change_password: true;
  /** Shown to the office once: it is not stored and no later response carries it. */
  one_time_password: string;
}

export async function createStudentAccount(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<StudentAccountIssued> {
  const password = oneTimePassword();
  const hash = await hashPassword(password);
  try {
    const r = await tx.query<{ user_id: string; login_id: string }>(
      `SELECT user_id, login_id FROM public.student_account_create($1::uuid, $2::uuid, $3::text)`,
      [input.tenantId, input.learnerId, hash],
    );
    const row = r.rows[0]!;
    return { learner_id: input.learnerId, user_id: row.user_id, login_id: row.login_id, must_change_password: true, one_time_password: password };
  } catch (err) {
    return mapDb(err);
  }
}

export async function resetStudentPassword(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<StudentAccountIssued> {
  const password = oneTimePassword();
  const hash = await hashPassword(password);
  try {
    const r = await tx.query<{ user_id: string; login_id: string }>(
      `SELECT user_id, login_id FROM public.student_account_reset_password($1::uuid, $2::uuid, $3::text)`,
      [input.tenantId, input.learnerId, hash],
    );
    const row = r.rows[0]!;
    return { learner_id: input.learnerId, user_id: row.user_id, login_id: row.login_id, must_change_password: true, one_time_password: password };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "P0002") throw notFound("This learner has no login");
    return mapDb(err);
  }
}

export async function revokeStudentAccount(tx: Tx, input: { tenantId: string; learnerId: string; reason: string }): Promise<void> {
  try {
    const r = await tx.query<{ ok: boolean }>(`SELECT public.student_account_revoke($1::uuid, $2::uuid, $3::text) AS ok`, [
      input.tenantId,
      input.learnerId,
      input.reason,
    ]);
    if (r.rows[0]?.ok !== true) throw notFound("This learner has no login");
  } catch (err) {
    mapDb(err);
  }
}

export interface StudentAccountStatus {
  learner_id: string;
  has_login: boolean;
  login_id: string | null;
  /** `active` or `disabled`; null without a login. */
  account_status: string | null;
  /** True until the learner replaces the one-time password. */
  must_change_password: boolean | null;
  created_at: string | null;
  password_set_at: string | null;
  last_sign_in_at: string | null;
  revoked_logins: number;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

export async function studentAccountStatus(tx: Tx, input: { tenantId: string; learnerId: string }): Promise<StudentAccountStatus> {
  try {
    const r = await tx.query<{
      has_login: boolean;
      login_id: string | null;
      account_status: string | null;
      must_change_password: boolean | null;
      created_at: Date | null;
      password_set_at: Date | null;
      last_sign_in_at: Date | null;
      revoked_logins: number;
    }>(`SELECT * FROM public.student_account_status($1::uuid, $2::uuid)`, [input.tenantId, input.learnerId]);
    const row = r.rows[0]!;
    return {
      learner_id: input.learnerId,
      has_login: row.has_login,
      login_id: row.login_id,
      account_status: row.account_status,
      must_change_password: row.has_login ? row.must_change_password : null,
      created_at: iso(row.created_at),
      password_set_at: iso(row.password_set_at),
      last_sign_in_at: iso(row.last_sign_in_at),
      revoked_logins: row.revoked_logins,
    };
  } catch (err) {
    return mapDb(err);
  }
}
