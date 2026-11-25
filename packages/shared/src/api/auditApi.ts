import type { AuditFilters } from "../audit";
import type { AuditEvent } from "../types";
import { apiClient } from "./client";
import { ApiError, isApiError, userMessage } from "./errors";
import type { components } from "./schema";

/**
 * The school's audit log on apps/api: the API side of audit.ts (docs/web-on-api/audit.md).
 *
 * Differences from Supabase, handled here rather than in the screen:
 *  - The API pages by CURSOR (`page.next_cursor`); the screen pages by OFFSET (how many rows it already shows). This keeps, for each
 *    school and filter set, the cursor that starts each page boundary it has read, so "Show older events" is one request. A boundary
 *    it does not know (a fresh page load that asks for a later page) is found by reading the pages before it.
 *  - A row carries what happened (`label`), who (`actor_name`) and when. It never carries the record's detail or an IP address (by
 *    design), so `metadata` is empty and the screen cannot list what changed field by field (`auditCapabilities().fieldChanges`).
 *  - The log is the school's BUSINESS events only: sign-in, session and two-step events, refusals, read events and personal settings are
 *    never returned (`auditCapabilities().everyChange`).
 *  - An event the system wrote on its own, and one whose account no longer exists, both have no actor: shown as "System".
 *  - `search` is at most 80 characters on the API; a longer one is cut here rather than refused.
 */

type ApiAuditEvent = components["schemas"]["SchoolAuditEvent"];

/** The longest `search` GET /audit-events accepts. */
export const API_AUDIT_SEARCH_MAX = 80;

/** Who an event with no actor is put down to. */
export const AUDIT_SYSTEM_ACTOR = "System";

export function auditEventFromApi(tenantId: string, e: ApiAuditEvent): AuditEvent {
  return {
    id: e.id,
    tenant_id: tenantId,
    actor_id: e.actor_user_id,
    actor_label: e.actor_name ?? (e.actor_user_id ? "Unknown person" : AUDIT_SYSTEM_ACTOR),
    event: e.label,
    category: e.category,
    // The API returns no detail. The event's own name is kept (it is what `event` was worded from), nothing else.
    metadata: { event_type: e.event_type },
    created_at: e.occurred_at,
  };
}

interface AuditQuery {
  category?: ApiAuditEvent["category"];
  since?: string;
  search?: string;
}

/** The filters as the API takes them: an empty one is left out, and a search is trimmed and cut to the API's limit. */
function auditQuery(filters: AuditFilters): AuditQuery {
  const query: AuditQuery = {};
  if (filters.category) query.category = filters.category;
  if (filters.since) query.since = filters.since;
  const search = filters.search?.trim().slice(0, API_AUDIT_SEARCH_MAX).trim();
  if (search) query.search = search;
  return query;
}

/** The sentence the screen shows when the log cannot be read. A refusal says what it means (the server's own words are "Missing permission"). */
function auditError(err: unknown): unknown {
  if (!isApiError(err)) return err;
  const message = err.code === "forbidden" ? "You don't have permission to read the audit log." : userMessage(err);
  if (message === err.message) return err;
  return new ApiError({ status: err.status, code: err.code, message, requestId: err.requestId, details: err.details, retryAfterSeconds: err.retryAfterSeconds });
}

async function readPage(tenantId: string, query: AuditQuery, limit: number, cursor: string | undefined) {
  try {
    return await apiClient().get("/v1/tenants/{tenantId}/audit-events", {
      path: { tenantId },
      query: { ...query, limit, cursor },
      tenantId,
    });
  } catch (err) {
    throw auditError(err);
  }
}

// ---------------------------------------------------------------- offset -> cursor

/** Filter sets whose cursors are kept. A person types searches one after another, so the oldest set is dropped past this. */
const MAX_FILTER_SETS = 20;

/** A runaway guard when a later page has to be found by reading the ones before it: 1,000 pages is 100,000 events. */
const MAX_WALK_PAGES = 1000;

/** For one school, filter set and page size: the offset at which a page starts -> the cursor that fetches it (the first page has none). */
const cursors = new Map<string, Map<number, string>>();

function cursorsFor(key: string): Map<number, string> {
  let held = cursors.get(key);
  if (held) {
    cursors.delete(key); // most recently used goes last
    cursors.set(key, held);
    return held;
  }
  held = new Map();
  cursors.set(key, held);
  if (cursors.size > MAX_FILTER_SETS) cursors.delete(cursors.keys().next().value as string);
  return held;
}

/** Forgets every cursor held (a school was left, or a test starts clean). */
export function resetAuditCursors(): void {
  cursors.clear();
}

/**
 * One page of the school's audit log, newest first, starting `offset` events in (the screen's "how many are already shown").
 * Reading from the start (offset 0) drops what was held for that filter set, so the cursors always follow the newest read.
 */
export async function apiFetchAuditEvents(tenantId: string, filters: AuditFilters, offset: number, limit: number): Promise<AuditEvent[]> {
  const query = auditQuery(filters);
  const held = cursorsFor(JSON.stringify([tenantId, limit, query]));
  if (offset <= 0) held.clear();

  // Start from the nearest page boundary at or before the offset that a cursor is held for.
  let at = 0;
  let cursor: string | undefined;
  for (const [boundary, c] of held) {
    if (boundary <= offset && boundary >= at) {
      at = boundary;
      cursor = c;
    }
  }

  const out: AuditEvent[] = [];
  for (let i = 0; i < MAX_WALK_PAGES; i++) {
    const page = await readPage(tenantId, query, limit, cursor);
    const events = page.events.map((e) => auditEventFromApi(tenantId, e));
    const next = page.page.next_cursor;
    if (next) held.set(at + events.length, next);
    if (at + events.length > offset) out.push(...events.slice(Math.max(0, offset - at)));
    if (out.length >= limit || !next) return out.slice(0, limit);
    at += events.length;
    cursor = next;
  }
  throw new Error("The audit log is longer than this screen can page through.");
}
