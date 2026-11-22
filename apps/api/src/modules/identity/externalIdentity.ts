import type { Db } from "../../db/pool.js";
import { conflict, validationError, forbidden } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";

export type ExternalProvider = "supabase_auth";

/**
 * Link a verified external subject to a local user (D-14).
 * Email match alone never proves identity — caller must supply a verified subject.
 */
export async function linkExternalIdentity(
  db: Db,
  input: {
    userId: string;
    provider: ExternalProvider;
    subject: string;
    emailAtLink?: string | null;
    verified: boolean;
    actorUserId?: string | null;
    ip?: string | null;
  },
): Promise<{ id: string }> {
  const subject = input.subject.trim();
  if (!subject) throw validationError("External subject is required");
  if (!input.verified) {
    throw forbidden("External identity must be verified before linking");
  }

  const existingSubject = await db.query(
    `SELECT id, user_id, status FROM external_identities
     WHERE provider = $1 AND subject = $2`,
    [input.provider, subject],
  );
  if (existingSubject.rows[0]) {
    const row = existingSubject.rows[0] as { id: string; user_id: string; status: string };
    if (row.user_id !== input.userId) {
      throw conflict("External identity is already linked to another user");
    }
    if (row.status === "active") return { id: row.id };
  }

  const activeForUser = await db.query(
    `SELECT id FROM external_identities
     WHERE user_id = $1 AND provider = $2 AND status = 'active'`,
    [input.userId, input.provider],
  );
  if ((activeForUser.rowCount ?? 0) > 0 && !existingSubject.rows[0]) {
    throw conflict("User already has an active identity for this provider");
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO external_identities (
       user_id, provider, subject, email_at_link, verified_at, status
     ) VALUES ($1, $2, $3, $4, now(), 'active')
     ON CONFLICT (provider, subject) DO UPDATE
       SET status = 'active',
           verified_at = now(),
           email_at_link = EXCLUDED.email_at_link
     WHERE external_identities.user_id = EXCLUDED.user_id
     RETURNING id`,
    [input.userId, input.provider, subject, input.emailAtLink ?? null],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw conflict("External identity link failed (collision policy)");

  await db.query(
    `INSERT INTO external_identity_link_events (external_identity_id, user_id, event_type, detail)
     VALUES ($1, $2, 'identity.linked', $3::jsonb)`,
    [
      id,
      input.userId,
      JSON.stringify({
        provider: input.provider,
        // Never store secrets; subject is an opaque id.
        subjectPresent: true,
      }),
    ],
  );
  await recordSecurityEvent(db, {
    eventType: "identity.external.linked",
    actorUserId: input.actorUserId ?? input.userId,
    detail: { provider: input.provider, externalIdentityId: id },
    ip: input.ip ?? null,
  });
  return { id };
}

export async function findUserByExternalIdentity(
  db: Db,
  provider: ExternalProvider,
  subject: string,
): Promise<string | null> {
  const result = await db.query<{ user_id: string }>(
    `SELECT user_id FROM external_identities
     WHERE provider = $1 AND subject = $2 AND status = 'active'`,
    [provider, subject.trim()],
  );
  return result.rows[0]?.user_id ?? null;
}
