import type { Tx } from "../../db/sql.js";
import { validationError } from "../../http/errors.js";
import { isRealCalendarDate } from "../../http/schemas.js";

/**
 * The school's audit log (docs/SCHOOL-AUDIT.md). What a school may read, and which events count as business events, is decided
 * in the database by `school_audit_events` (migration 106); this module only parses the filters, calls it and words the rows.
 * Read only: nothing here writes an event or changes one.
 */
export const SCHOOL_AUDIT_READ = "resource.audit.read" as const;

/** The web console's eight categories, in its order. The database function accepts exactly these. */
export const AUDIT_CATEGORIES = ["provisioning", "access", "academic", "financial", "health", "transport", "communication", "operations"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export function parseAuditCategory(value: unknown): AuditCategory | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(AUDIT_CATEGORIES as readonly string[]).includes(value)) {
    throw validationError(`category must be one of: ${AUDIT_CATEGORIES.join(", ")}`);
  }
  return value as AuditCategory;
}

/** `since` is a calendar day, yyyy-mm-dd: that day (from 00:00 UTC) and later. Returned as the instant the database compares with. */
export function parseAuditSince(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isRealCalendarDate(value)) {
    throw validationError("since must be a real date, yyyy-mm-dd");
  }
  return `${value}T00:00:00.000Z`;
}

const MAX_SEARCH = 80;

/** Matched, case-insensitively, against who did it and the event's own words. Wildcards mean nothing (the database searches by position). */
export function parseAuditSearch(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw validationError("search must be text");
  const text = value.trim();
  if (text === "") return undefined;
  if (text.length > MAX_SEARCH) throw validationError(`search must be at most ${MAX_SEARCH} characters`);
  return text;
}

/** Plainer words for the events people ask about most. Every other event is worded from its own name (see `auditEventLabel`). */
const LABELS: Record<string, string> = {
  "academics.mark.upserted": "Marks saved",
  "academics.competency.rated": "Competency rated",
  "academics.timetable.published": "Timetable published",
  "academics.year.current_set": "Current academic year set",
  "academics.term.current_set": "Current term set",
  "attendance.register.upserted": "Register saved",
  "attendance.early_sign_out.recorded": "Early sign-out recorded",
  "attendance.early_sign_out.voided": "Early sign-out voided",
  "communications.announcement.published": "Announcement published",
  "communications.visit.created": "Visitor logged",
  "communications.visit.advanced": "Visit moved on",
  "directory.school_profile.updated": "School profile updated",
  "finance.payment.recorded": "Payment recorded",
  "finance.term.billed": "Term billed",
  "finance.invoice.sent": "Invoice sent",
  "finance.invoice.voided": "Invoice voided",
  "finance.invoice.adjusted": "Invoice adjusted",
  "finance.proof.confirmed": "Payment proof confirmed",
  "finance.proof.rejected": "Payment proof rejected",
  "import.learners.applied": "Learner import applied",
  "import.learners.previewed": "Learner import previewed",
  "rbac.staff_areas.changed": "Admin areas changed",
  "rbac.school_role.changed": "School role changed",
  "rbac.guardian_access.granted": "Guardian access granted",
  "rbac.guardian_access.revoked": "Guardian access removed",
  "rbac.org_delegation.granted": "Organisation access granted",
  "rbac.org_delegation.revoked": "Organisation access removed",
  "reporting.export.requested": "Export requested",
  "reporting.export.downloaded": "Export downloaded",
  "storage.object.deleted": "File deleted",
};

/** A sentence for an event: a known wording, or the event's own name without its domain ("directory.learner.created" is "Learner created"). */
export function auditEventLabel(eventType: string): string {
  const known = LABELS[eventType];
  if (known) return known;
  const words = eventType.split(".").slice(1).join(" ").replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : eventType;
}

export interface SchoolAuditRow {
  id: string;
  occurred_at_text: string;
  event_type: string;
  category: AuditCategory;
  actor_user_id: string | null;
  actor_name: string | null;
}

export interface SchoolAuditEvent {
  id: string;
  occurred_at: string;
  event_type: string;
  label: string;
  category: AuditCategory;
  actor_user_id: string | null;
  actor_name: string | null;
}

/**
 * The next rows of the school's audit log, newest first, strictly after the cursor. The school and the caller come from the
 * transaction settings the API set after authorising the request. `limit` is already one more than the page, to see if there is a next one.
 */
export async function readSchoolAuditRows(
  tx: Tx,
  input: { category?: AuditCategory; since?: string; search?: string; cursor: { beforeAt: string; beforeId: string } | null; limit: number },
): Promise<SchoolAuditRow[]> {
  const res = await tx.query<SchoolAuditRow>(
    `SELECT id, occurred_at_text, event_type, category, actor_user_id, actor_name
       FROM public.school_audit_events($1::text, $2::timestamptz, $3::text, $4::timestamptz, $5::uuid, $6::integer)`,
    [input.category ?? null, input.since ?? null, input.search ?? null, input.cursor?.beforeAt ?? null, input.cursor?.beforeId ?? null, input.limit],
  );
  return res.rows;
}

export function toSchoolAuditEvent(row: SchoolAuditRow): SchoolAuditEvent {
  return {
    id: row.id,
    occurred_at: row.occurred_at_text,
    event_type: row.event_type,
    label: auditEventLabel(row.event_type),
    category: row.category,
    actor_user_id: row.actor_user_id,
    actor_name: row.actor_name,
  };
}
