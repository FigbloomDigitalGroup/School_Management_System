import type { Tx } from "../../db/sql.js";
import { notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { uuidString } from "../../http/schemas.js";
import { pageQuery, type PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { SCHOOL_ROLES } from "../identity/roles.js";

export type AnnouncementChannel = "in_app" | "push" | "sms" | "email";

export interface AnnouncementRow {
  id: string;
  tenant_id: string;
  author_id: string;
  subject: string;
  body: string;
  audience: Record<string, unknown>;
  channels: AnnouncementChannel[];
  published_at: string | null;
  created_at: string;
}

export interface AnnouncementDeliveryRow {
  id: string;
  tenant_id: string;
  announcement_id: string;
  channel: "push" | "sms" | "email";
  status: "queued" | "skipped_no_provider" | "failed" | "sent";
  detail: Record<string, unknown>;
  created_at: string;
}

const COLS = `id, tenant_id, author_id, subject, body, audience, channels, published_at, created_at`;
const VALID_ROLES = new Set<string>(SCHOOL_ROLES);

function mapRow(r: AnnouncementRow & { page_key?: string }): AnnouncementRow {
  const { page_key: _pageKey, ...rest } = r;
  return {
    ...rest,
    channels: rest.channels as AnnouncementChannel[],
    published_at: rest.published_at,
  };
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && uuidString.safeParse(v).success;
}

export function assertAudienceShape(audience: Record<string, unknown>): void {
  const kind = audience.kind;
  if (typeof kind !== "string") throw validationError("audience.kind is required");
  switch (kind) {
    case "whole_school":
      return;
    case "role":
      if (typeof audience.role !== "string" || !VALID_ROLES.has(audience.role)) {
        throw validationError("audience.role must be a valid school role");
      }
      return;
    case "roles": {
      if (!Array.isArray(audience.roles) || audience.roles.length === 0 || audience.roles.length > SCHOOL_ROLES.length) {
        throw validationError("audience.roles must be a non-empty array of school roles");
      }
      const seen = new Set<string>();
      for (const r of audience.roles) {
        if (typeof r !== "string" || !VALID_ROLES.has(r)) {
          throw validationError("audience.roles must contain only valid school roles");
        }
        if (seen.has(r)) throw validationError("audience.roles must not contain duplicates");
        seen.add(r);
      }
      return;
    }
    case "user":
      if (!isUuid(audience.user_id)) throw validationError("audience.user_id must be a UUID");
      return;
    case "people":
      if (!Array.isArray(audience.profile_ids) || audience.profile_ids.length === 0 || audience.profile_ids.length > 200) {
        throw validationError("audience.profile_ids must be a non-empty array of UUIDs (max 200)");
      }
      for (const pid of audience.profile_ids) {
        if (!isUuid(pid)) throw validationError("audience.profile_ids must contain only UUIDs");
      }
      return;
    case "class":
      if (!isUuid(audience.class_id)) throw validationError("audience.class_id must be a UUID");
      return;
    case "form_level":
      if (
        typeof audience.form_level !== "number" ||
        !Number.isInteger(audience.form_level) ||
        audience.form_level < 1 ||
        audience.form_level > 12
      ) {
        throw validationError("audience.form_level must be an integer between 1 and 12");
      }
      return;
    default:
      throw validationError("unsupported audience.kind");
  }
}

export async function createAnnouncement(
  tx: Tx,
  input: {
    tenantId: string;
    authorId: string;
    subject: string;
    body: string;
    audience: Record<string, unknown>;
    channels: AnnouncementChannel[];
  },
): Promise<AnnouncementRow> {
  assertAudienceShape(input.audience);
  if (!input.channels.includes("in_app")) throw validationError("in_app channel is required");
  if (input.audience.kind === "class") {
    const classId = input.audience.class_id as string;
    const cls = await tx.query(
      `SELECT 1 FROM classes WHERE tenant_id = $1 AND id = $2 AND active = true AND archived_at IS NULL`,
      [input.tenantId, classId],
    );
    if (!cls.rows[0]) {
      throw validationError("audience.class_id must reference an active class in this school");
    }
  }
  const res = await tx.query<AnnouncementRow>(
    `INSERT INTO communications_announcements (tenant_id, author_id, subject, body, audience, channels)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[])
     RETURNING ${COLS}`,
    [input.tenantId, input.authorId, input.subject.trim(), input.body.trim(), JSON.stringify(input.audience), input.channels],
  );
  const row = mapRow(res.rows[0]!);
  await recordSecurityEvent(tx, {
    eventType: "communications.announcement.created",
    actorUserId: input.authorId,
    tenantId: input.tenantId,
    detail: { announcementId: row.id, channels: row.channels, audienceKind: input.audience.kind },
  });
  return row;
}

export async function getAnnouncement(tx: Tx, tenantId: string, id: string): Promise<AnnouncementRow | null> {
  const res = await tx.query<AnnouncementRow>(`SELECT ${COLS} FROM communications_announcements WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
  ]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function listAnnouncementDeliveries(
  tx: Tx,
  tenantId: string,
  announcementId: string,
): Promise<AnnouncementDeliveryRow[]> {
  const res = await tx.query<AnnouncementDeliveryRow>(
    `SELECT id, tenant_id, announcement_id, channel, status, detail, created_at
       FROM communications_announcement_deliveries
      WHERE tenant_id = $1 AND announcement_id = $2
      ORDER BY created_at ASC, id ASC`,
    [tenantId, announcementId],
  );
  return res.rows;
}

export async function listAnnouncements(
  tx: Tx,
  input: {
    tenantId: string;
    publishedOnly?: boolean;
    limit: number;
    rawCursor?: unknown;
    cursorCreatedAt?: string;
    cursorId?: string;
  },
): Promise<{ announcements: AnnouncementRow[]; page: PageInfo }> {
  const page: PageInput = { limit: input.limit, rawCursor: input.rawCursor };
  const inner = input.publishedOnly
    ? `SELECT ${COLS} FROM communications_announcements WHERE tenant_id = $1 AND published_at IS NOT NULL`
    : `SELECT ${COLS} FROM communications_announcements WHERE tenant_id = $1`;
  const res = await pageQuery<AnnouncementRow>(
    tx,
    inner,
    [input.tenantId],
    {
      name: input.publishedOnly ? "announcements_published_created_desc" : "announcements_all_created_desc",
      expr: "q.created_at",
      type: "timestamptz",
      dir: "desc",
    },
    page,
  );
  return { announcements: res.rows.map(mapRow), page: res.page };
}

export async function listVisiblePublished(
  tx: Tx,
  input: { tenantId: string; userId: string; limit: number; rawCursor?: unknown },
): Promise<{ announcements: AnnouncementRow[]; page: PageInfo }> {
  const page: PageInput = { limit: input.limit, rawCursor: input.rawCursor };
  const inner = `SELECT ${COLS} FROM communications_announcements a
      WHERE a.tenant_id = $1 AND a.published_at IS NOT NULL
        AND (a.author_id = $2 OR public.communications_audience_reaches($1, a.audience, $2))`;
  const res = await pageQuery<AnnouncementRow>(
    tx,
    inner,
    [input.tenantId, input.userId],
    {
      name: "announcements_inbox_published_desc",
      expr: "q.published_at",
      type: "timestamptz",
      dir: "desc",
    },
    page,
  );
  return { announcements: res.rows.map(mapRow), page: res.page };
}

export async function publishAnnouncement(
  tx: Tx,
  input: { tenantId: string; announcementId: string; actorUserId: string; settleDelaySeconds?: number },
): Promise<AnnouncementRow> {
  const res = await tx.query<AnnouncementRow>(
    `UPDATE communications_announcements SET published_at = now()
      WHERE tenant_id = $1 AND id = $2 AND published_at IS NULL
      RETURNING ${COLS}`,
    [input.tenantId, input.announcementId],
  );
  if (!res.rows[0]) {
    const existing = await getAnnouncement(tx, input.tenantId, input.announcementId);
    if (!existing) throw notFound("Announcement not found");
    if (existing.published_at) return existing;
    throw notFound("Announcement not found");
  }
  const row = mapRow(res.rows[0]);
  await recordSecurityEvent(tx, {
    eventType: "communications.announcement.published",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { announcementId: row.id, channels: row.channels },
  });
  if (row.channels.includes("push")) {
    await tx.query(
      `INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after, enqueued_by_user_id)
       VALUES ($1, 'announcement.push', $2::jsonb, $3, now(), $4)
       ON CONFLICT (tenant_id, job_type, idempotency_key) DO NOTHING`,
      [
        input.tenantId,
        JSON.stringify({ announcementId: row.id }),
        `announcement.push:${row.id}`,
        input.actorUserId,
      ],
    );
  }
  for (const deferred of ["sms", "email"] as const) {
    if (row.channels.includes(deferred)) {
      await tx.query(
        `INSERT INTO communications_announcement_deliveries (tenant_id, announcement_id, channel, status, detail)
         VALUES ($1, $2, $3, 'skipped_no_provider', $4::jsonb)`,
        [
          input.tenantId,
          row.id,
          deferred,
          JSON.stringify({ reason: "owner_disposition_pending", note: "SMS/email announcement delivery awaits Stage 12 owner decision" }),
        ],
      );
    }
  }
  return row;
}

export async function markRead(
  tx: Tx,
  input: { tenantId: string; announcementId: string; userId: string },
): Promise<void> {
  const ann = await getAnnouncement(tx, input.tenantId, input.announcementId);
  if (!ann || !ann.published_at) throw notFound("Announcement not found");
  const visible = await tx.query<{ ok: boolean }>(
    `SELECT (author_id = $2 OR public.communications_audience_reaches($1, audience, $2)) AS ok
       FROM communications_announcements WHERE tenant_id = $1 AND id = $3`,
    [input.tenantId, input.userId, input.announcementId],
  );
  if (!visible.rows[0]?.ok) throw notFound("Announcement not found");
  await tx.query(
    `INSERT INTO communications_announcement_reads (tenant_id, announcement_id, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (announcement_id, user_id) DO NOTHING`,
    [input.tenantId, input.announcementId, input.userId],
  );
}
