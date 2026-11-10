/**
 * The one-off leave history export (SCHOOLS_HR_LEAVE_CONTRACT.md section 3; platform-sync leave_history_import):
 * a school's approved Schools leave goes to HR's import, POST <HR_MY_HR_URL>/import/leave-history (Schools' platform
 * token, x-figbloom-school, no person; bloomHR my_hr_routes.js), where it becomes approved historical applications
 * counted in balances.
 *
 *   platform_leave_history(school) (20261105800000) lists what hasn't been exported, for staff HR knows (their
 *   schools.staff event was delivered); the others are listed as not_linked and not sent.
 *   A dry run lists, and when HR can be reached also asks HR's own dry run (dry_run: true: each record tried and
 *   rolled back), so it shows what HR would do with each one (would_import, not_linked, refused, ...).
 *   For real, it is sent in batches of up to 5000 (HR's limit). HR answers per record:
 *     imported | already_imported   marked exported (platform_leave_history_mark), never sent again
 *     not_linked | skipped | invalid | refused   not marked, listed with HR's message
 *   HR is idempotent on source_id (the leave_requests id), so running it again is safe and sends only what is left.
 */

import type { PlatformClient } from "./platformClient.ts";
import { callHr, errorCode, readJson } from "./hrApi.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

/** HR's IMPORT_MAX_RECORDS. */
export const HISTORY_BATCH = 5000;
const DONE = new Set(["imported", "already_imported"]);

export interface HistoryRecord {
  source_id: string;
  external_id: string;
  full_name: string | null;
  leave_type_name: string;
  start_date: string;
  end_date: string;
  days: number;
  status: string;
  reason: string | null;
}

/** One record as HR answered it. */
export interface HrOutcome { source_id: string | null; external_id: string | null; outcome: string; message: string | null }

export interface LeaveHistoryReport {
  school_id: string;
  dry_run: boolean;
  school_linked: boolean;
  /** what is (or would be) sent */
  count: number;
  records?: HistoryRecord[];
  /** approved leave of staff HR doesn't know yet (no delivered schools.staff event): not sent */
  not_linked: { external_id: string; full_name: string | null; source_id: string }[];
  /** HR's counts by outcome (imported, would_import, already_imported, not_linked, skipped, invalid, refused) */
  hr_counts?: Record<string, number>;
  /** the records HR did not import (or, in a dry run, every record), with HR's message */
  hr_results?: HrOutcome[];
  /** the dry run couldn't ask HR (not configured, not linked, or HR refused): why */
  hr_dry_run_error?: string;
  sent?: number;
  marked?: number;
}

export class HrImportError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly marked: number) {
    super(`HR's leave history import answered ${status} ${code ?? ""}`.trim());
    this.name = "HrImportError";
  }
}

/** HR's answer: {dry_run, counts, results: [{source_id, external_id, outcome, application_id?, message?}]}. */
function outcomes(answer: unknown): { counts: Record<string, number>; results: HrOutcome[] } {
  // deno-lint-ignore no-explicit-any
  const a = answer as any;
  const results: HrOutcome[] = Array.isArray(a?.results)
    ? a.results.filter((r: unknown) => r && typeof r === "object").map((r: Record<string, unknown>) => ({
      source_id: typeof r.source_id === "string" ? r.source_id : null,
      external_id: typeof r.external_id === "string" ? r.external_id : null,
      outcome: typeof r.outcome === "string" ? r.outcome : "unknown",
      message: typeof r.message === "string" ? r.message.slice(0, 300) : null,
    }))
    : [];
  const counts: Record<string, number> = {};
  if (a?.counts && typeof a.counts === "object") {
    for (const [k, v] of Object.entries(a.counts)) if (typeof v === "number") counts[k] = v;
  } else {
    for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  }
  return { counts, results };
}

const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

async function send(fetchFn: typeof fetch, client: PlatformClient, hrUrl: string, schoolId: string, batch: HistoryRecord[], dryRun: boolean) {
  return await callHr(fetchFn, client, `${hrUrl}/import/leave-history`, {
    method: "POST", school: schoolId, timeoutMs: 120_000,
    body: {
      dry_run: dryRun,
      records: batch.map((r) => ({
        external_id: r.external_id, leave_type_name: r.leave_type_name, start_date: r.start_date, end_date: r.end_date,
        days: r.days, status: r.status, source_id: r.source_id,
      })),
    },
  });
}

export async function leaveHistoryImport(admin: Admin, opts: {
  schoolId: string; dryRun: boolean; client: PlatformClient | null; hrUrl: string | null; fetch?: typeof fetch;
}): Promise<LeaveHistoryReport> {
  const { schoolId, dryRun, client, hrUrl, fetch: fetchFn = fetch } = opts;
  const { data, error } = await admin.rpc("platform_leave_history", { p_tenant_id: schoolId });
  if (error) throw new Error(error.message);
  const records = (data?.records ?? []) as HistoryRecord[];
  const notLinked = (data?.not_linked ?? []) as LeaveHistoryReport["not_linked"];
  const base = { school_id: schoolId, school_linked: data?.school_linked === true, not_linked: notLinked };

  if (dryRun) {
    const report: LeaveHistoryReport = { ...base, dry_run: true, count: records.length, records };
    if (!records.length) return report;
    if (!client || !hrUrl) return { ...report, hr_dry_run_error: "hr_not_configured" };
    if (!base.school_linked) return { ...report, hr_dry_run_error: "school_not_linked" };
    const counts: Record<string, number> = {};
    const results: HrOutcome[] = [];
    try {
      for (let i = 0; i < records.length; i += HISTORY_BATCH) {
        const res = await send(fetchFn, client, hrUrl, schoolId, records.slice(i, i + HISTORY_BATCH), true);
        const answer = await readJson(res);
        if (!res.ok) return { ...report, hr_dry_run_error: `HR answered ${res.status} ${errorCode(answer) ?? ""}`.trim() };
        const o = outcomes(answer);
        add(counts, o.counts);
        results.push(...o.results);
      }
    } catch (err) {
      return { ...report, hr_dry_run_error: err instanceof Error ? err.message : String(err) };
    }
    return { ...report, hr_counts: counts, hr_results: results };
  }

  if (!client || !hrUrl) throw new Error("hr_not_configured");
  if (!base.school_linked) throw new Error("school_not_linked");

  let sent = 0;
  let marked = 0;
  const counts: Record<string, number> = {};
  const notImported: HrOutcome[] = [];
  for (let i = 0; i < records.length; i += HISTORY_BATCH) {
    const batch = records.slice(i, i + HISTORY_BATCH);
    const res = await send(fetchFn, client, hrUrl, schoolId, batch, false);
    const answer = await readJson(res);
    if (!res.ok) throw new HrImportError(res.status, errorCode(answer), marked);
    sent += batch.length;
    const o = outcomes(answer);
    add(counts, o.counts);
    const ours = new Set(batch.map((r) => r.source_id));
    const done = o.results.filter((r) => r.source_id && ours.has(r.source_id) && DONE.has(r.outcome)).map((r) => r.source_id!);
    notImported.push(...o.results.filter((r) => !DONE.has(r.outcome)));
    if (done.length) {
      const { data: n, error: markError } = await admin.rpc("platform_leave_history_mark", { p_tenant_id: schoolId, p_ids: done });
      if (markError) throw new Error(`could not mark the exported leave: ${markError.message}`);
      marked += Number(n ?? 0);
    }
  }
  return { ...base, dry_run: false, count: records.length, sent, marked, hr_counts: counts, hr_results: notImported };
}
