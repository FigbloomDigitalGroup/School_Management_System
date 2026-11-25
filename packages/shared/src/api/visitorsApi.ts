import type { Visit, VisitDraft, VisitHost, VisitLearner, VisitStatus } from "../visitors";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { listClassesOrEmpty, listLearnersOrEmpty, listMembershipsOrEmpty } from "./feesApi";
import { API_PAGE_LIMIT } from "./paging";
import { activeTenantId, listStaffMembers } from "./peopleApi";
import { POLL_MS, startPolling, type PollOptions } from "./poll";
import type { components } from "./schema";

/**
 * Gate & reception visitor log on apps/api: the API side of `visitors.ts`.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `GET /gate-visits` has no `since`/`until` date query parameters, so `apiListVisits` pages
 *    newest-first and stops as soon as a page reaches visits older than `since`.
 *  - Advancing status uses `POST /gate-visits/{visitId}/advance` with `{ status }`.
 *  - Escalating an existing visit after arrival is not on the API (visits for `host_kind: "principal"`
 *    are escalated on arrival by the server).
 *  - Realtime `postgres_changes` is replaced with 10-second polling via `startPolling` (`POLL_MS.live`).
 */

type ApiGateVisit = components["schemas"]["GateVisit"];

export const POLL_VISITS_LIMIT = 50;

export function visitFromApi(v: ApiGateVisit): Visit {
  return {
    id: v.id,
    tenant_id: v.tenant_id,
    visitor_name: v.visitor_name,
    visitor_phone: v.visitor_phone ?? null,
    id_number: v.id_number ?? null,
    vehicle_plate: v.vehicle_plate ?? null,
    purpose: v.purpose,
    host_kind: v.host_kind,
    host_id: v.host_user_id ?? null,
    student_id: v.learner_id ?? null,
    host_name: v.host_name ?? null,
    student_name: v.learner_name ?? null,
    entry_point: v.entry_point,
    status: v.status,
    escalated: v.escalated,
    escalated_at: v.escalated_at ?? null,
    note: v.note ?? null,
    recorded_by: v.recorded_by ?? null,
    arrived_at: v.arrived_at,
    reception_at: v.reception_at ?? null,
    with_host_at: v.with_host_at ?? null,
    left_at: v.left_at ?? null,
    updated_at: v.updated_at,
  };
}

/** Visits that arrived since `since` (and before `until`, when given), newest first. */
export async function apiListVisits(tenantId: string, since: Date, until?: Date, opts?: { mine?: boolean }): Promise<Visit[]> {
  const sinceIso = since.toISOString();
  const untilIso = until?.toISOString();
  const out: Visit[] = [];
  let cursor: string | undefined;

  for (;;) {
    const res = await apiClient().get("/v1/tenants/{tenantId}/gate-visits", {
      path: { tenantId },
      query: { limit: API_PAGE_LIMIT, cursor, ...(opts?.mine ? { mine: "true" as const } : {}) },
      tenantId,
    });
    for (const v of res.visits) {
      if (v.arrived_at >= sinceIso && (!untilIso || v.arrived_at < untilIso)) {
        out.push(visitFromApi(v));
      }
    }
    const last = res.visits[res.visits.length - 1];
    if (!res.page.next_cursor || !last || last.arrived_at < sinceIso) break;
    cursor = res.page.next_cursor;
  }
  return out;
}

/** Records a new gate or reception visit on apps/api. */
export async function apiRecordVisit(
  tenantId: string,
  draft: VisitDraft,
  entryPoint: Visit["entry_point"],
): Promise<Visit> {
  const res = await apiClient().post("/v1/tenants/{tenantId}/gate-visits", {
    path: { tenantId },
    body: {
      visitor_name: draft.visitor_name.trim(),
      visitor_phone: draft.visitor_phone?.trim() || null,
      id_number: draft.id_number?.trim() || null,
      vehicle_plate: draft.vehicle_plate?.trim().toUpperCase() || null,
      purpose: draft.purpose.trim(),
      host_kind: draft.host_kind,
      host_user_id: draft.host_kind === "teacher" ? (draft.host_id ?? null) : null,
      learner_id: draft.host_kind === "learner" ? (draft.student_id ?? null) : null,
      entry_point: entryPoint,
    },
    tenantId,
  });
  return visitFromApi(res.visit);
}

/** Advances a visit's status on apps/api and returns the updated visit. */
export async function apiSetVisitStatus(id: string, status: VisitStatus, tenantId?: string): Promise<Visit> {
  const tid = tenantId ?? activeTenantId();
  const res = await apiClient().post("/v1/tenants/{tenantId}/gate-visits/{visitId}/advance", {
    path: { tenantId: tid, visitId: id },
    body: { status },
    tenantId: tid,
  });
  return visitFromApi(res.visit);
}

/** Staff with user accounts who can host visitors on apps/api. */
export async function apiFetchVisitHosts(tenantId: string): Promise<VisitHost[]> {
  try {
    const staff = await listStaffMembers(tenantId, true);
    return staff
      .filter((s) => s.userId !== null)
      .map((s) => ({
        id: s.userId!,
        full_name: s.full_name,
        role: s.classification,
        staff_title: s.staff_title,
      }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
}

/** Searches active learners by name or admission number on apps/api. */
export async function apiFindVisitLearners(tenantId: string, query: string): Promise<VisitLearner[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const [learners, memberships, classes] = await Promise.all([
    listLearnersOrEmpty(tenantId),
    listMembershipsOrEmpty(tenantId),
    listClassesOrEmpty(tenantId),
  ]);

  const classById = new Map(classes.map((c) => [c.id, c.name]));
  const classByLearner = new Map<string, string>();
  for (const m of memberships) {
    const name = classById.get(m.class_id);
    if (name) classByLearner.set(m.learner_id, name);
  }

  return learners
    .filter((l) => l.full_name.toLowerCase().includes(q) || l.admission_no.toLowerCase().includes(q))
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
    .slice(0, 20)
    .map((l) => ({
      id: l.id,
      full_name: l.full_name,
      admission_no: l.admission_no,
      class_name: classByLearner.get(l.id) ?? null,
    }));
}

/** Polls `/gate-visits` every 10 seconds in place of Supabase realtime, emitting new and updated visits. */
export function apiSubscribeVisits(
  tenantId: string,
  onChange: (v: Visit, isNew: boolean) => void,
  pollOpts?: Partial<PollOptions> & { mine?: boolean },
): () => void {
  const { mine, ...restPollOpts } = pollOpts ?? {};
  const seen = new Map<string, string>();
  let seeded = false;

  return startPolling(
    async (signal) => {
      const res = await apiClient().get("/v1/tenants/{tenantId}/gate-visits", {
        path: { tenantId },
        query: { limit: POLL_VISITS_LIMIT, ...(mine ? { mine: "true" as const } : {}) },
        tenantId,
        signal,
      });
      const items = res.visits.map(visitFromApi);
      if (!seeded) {
        for (const v of items) seen.set(v.id, `${v.status}|${v.escalated}|${v.updated_at}`);
        seeded = true;
        return;
      }
      // Emit oldest-first among changed/new rows from this newest-first page.
      for (let i = items.length - 1; i >= 0; i--) {
        const v = items[i]!;
        const sig = `${v.status}|${v.escalated}|${v.updated_at}`;
        const prev = seen.get(v.id);
        if (prev === undefined) {
          seen.set(v.id, sig);
          onChange(v, true);
        } else if (prev !== sig) {
          seen.set(v.id, sig);
          onChange(v, false);
        }
      }
    },
    { intervalMs: POLL_MS.live, ...restPollOpts },
  );
}
