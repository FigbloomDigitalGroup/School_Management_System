import { supabase } from "./supabase";
import type { AuditEvent } from "./types";

/**
 * A school's audit log (audit_events). The database writes every event
 * (20261104000000); nobody can change or remove one. Readable by full admins
 * and by whoever holds the "audit" admin area (20261104200000).
 */

export const AUDIT_CATEGORIES: { value: AuditEvent["category"]; label: string }[] = [
  { value: "provisioning", label: "People & setup" },
  { value: "access", label: "Access" },
  { value: "academic", label: "Academic" },
  { value: "financial", label: "Financial" },
  { value: "health", label: "Health" },
  { value: "transport", label: "Transport" },
  { value: "communication", label: "Communication" },
  { value: "operations", label: "Operations" },
];

export const AUDIT_PAGE_SIZE = 100;

export interface AuditFilters {
  category?: AuditEvent["category"] | "";
  /** Matched against the event's wording and who did it. */
  search?: string;
  /** yyyy-mm-dd: this day and later. */
  since?: string;
}

/** One page of a school's events, newest first. `offset` is how many are already shown. */
export async function fetchAuditEvents(tenantId: string, filters: AuditFilters = {}, offset = 0): Promise<AuditEvent[]> {
  let q = supabase().from("audit_events")
    .select("id, tenant_id, actor_id, actor_label, event, category, metadata, created_at")
    .eq("tenant_id", tenantId);
  if (filters.category) q = q.eq("category", filters.category);
  // commas and brackets would break the or() filter; they never matter to a search
  const search = filters.search?.trim().replace(/[%_,()*]/g, " ").trim();
  if (search) q = q.or(`event.ilike.*${search}*,actor_label.ilike.*${search}*`);
  if (filters.since) q = q.gte("created_at", filters.since);
  const { data, error } = await q
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + AUDIT_PAGE_SIZE - 1)
    .returns<AuditEvent[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export interface AuditChange {
  /** Which record, from its key ("id", or the columns of a composite key), when the event names one. */
  record: string | null;
  field: string;
  from: unknown;
  to: unknown;
  /** The value is kept out of the log (health, documents, exam answers, leave, visits): only that it changed. */
  hidden: boolean;
}

const fieldLabel = (column: string) => column.replace(/_/g, " ");

function changesOf(record: string | null, changes: unknown): AuditChange[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return Object.entries(changes as Record<string, unknown>).map(([column, v]) => {
    const pair = v && typeof v === "object" ? (v as { from?: unknown; to?: unknown }) : null;
    return { record, field: fieldLabel(column), from: pair?.from ?? null, to: pair?.to ?? null, hidden: pair === null };
  });
}

/**
 * What an event says changed, field by field. Two shapes are in the log: the
 * generic trigger's ({ changes: [{ key, changes: { column: { from, to } } }] })
 * and the fee triggers' ({ changes: { column: { from, to } } }). Anything else
 * (an event a function worded itself) has no field list.
 */
export function auditChanges(metadata: Record<string, unknown> | null | undefined): AuditChange[] {
  const changes = metadata?.changes;
  if (Array.isArray(changes)) {
    return changes.flatMap((item) => {
      const { key, changes: inner } = (item ?? {}) as { key?: Record<string, unknown>; changes?: unknown };
      const record = key && typeof key === "object" ? Object.values(key).map(String).join(" · ") : null;
      return changesOf(record, inner);
    });
  }
  return changesOf(null, changes);
}

/** A logged value as text: strings as they are, nothing as "—", anything else as JSON. */
export function auditValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}
