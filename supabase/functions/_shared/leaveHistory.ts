/**
 * The one-off leave history export (SCHOOLS_HR_LEAVE_CONTRACT.md section 3; platform-sync leave_history_import):
 * a school's approved Schools leave goes to HR's import, POST <HR_MY_HR_URL>/import/leave-history (Schools' platform
 * token, x-figbloom-school, no person), where it becomes approved historical applications counted in balances.
 *
 *   platform_leave_history(school) (20261105800000) lists what hasn't been exported, for staff HR knows (their
 *   schools.staff event was delivered); the others are listed as not_linked and not sent. A dry run only lists.
 *   For real, it is sent in batches; HR is idempotent on source_id (the leave_requests id), and what HR accepted is
 *   marked (platform_leave_history_mark), so running it again sends only what is left. A record HR answers as
 *   skipped/rejected (with its source_id) is not marked, and is listed.
 */

import type { PlatformClient } from "./platformClient.ts";
import { callHr, errorCode, readJson } from "./hrApi.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export const HISTORY_BATCH = 200;

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

export interface LeaveHistoryReport {
  school_id: string;
  dry_run: boolean;
  school_linked: boolean;
  /** what is (or would be) sent */
  count: number;
  records?: HistoryRecord[];
  /** approved leave of staff HR doesn't know yet: not sent */
  not_linked: { external_id: string; full_name: string | null; source_id: string }[];
  sent?: number;
  marked?: number;
  refused_by_hr?: { source_id: string; reason: string | null }[];
}

export class HrImportError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly marked: number) {
    super(`HR's leave history import answered ${status} ${code ?? ""}`.trim());
    this.name = "HrImportError";
  }
}

/** HR's answer: the records it skipped or refused, by source_id ({skipped|rejected|errors: [{source_id, reason|code}]}). */
function refusals(answer: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  // deno-lint-ignore no-explicit-any
  const a = answer as any;
  for (const key of ["skipped", "rejected", "errors", "failed"]) {
    const list = a?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = typeof item === "string" ? item : item?.source_id;
      if (typeof id !== "string") continue;
      const why = typeof item?.reason === "string" ? item.reason : typeof item?.code === "string" ? item.code : typeof item?.error === "string" ? item.error : null;
      out.set(id, why);
    }
  }
  return out;
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
  if (dryRun) return { ...base, dry_run: true, count: records.length, records };

  if (!client || !hrUrl) throw new Error("hr_not_configured");
  if (!base.school_linked) throw new Error("school_not_linked");

  let sent = 0;
  let marked = 0;
  const refused: { source_id: string; reason: string | null }[] = [];
  for (let i = 0; i < records.length; i += HISTORY_BATCH) {
    const batch = records.slice(i, i + HISTORY_BATCH);
    const res = await callHr(fetchFn, client, `${hrUrl}/import/leave-history`, {
      method: "POST", school: schoolId, timeoutMs: 60_000,
      body: {
        dry_run: false,
        records: batch.map((r) => ({
          external_id: r.external_id, leave_type_name: r.leave_type_name, start_date: r.start_date, end_date: r.end_date,
          days: r.days, status: r.status, source_id: r.source_id,
        })),
      },
    });
    const answer = await readJson(res);
    if (!res.ok) throw new HrImportError(res.status, errorCode(answer), marked);
    sent += batch.length;
    const no = refusals(answer);
    for (const [source_id, reason] of no) if (batch.some((r) => r.source_id === source_id)) refused.push({ source_id, reason });
    const accepted = batch.filter((r) => !no.has(r.source_id)).map((r) => r.source_id);
    if (accepted.length) {
      const { data: n, error: markError } = await admin.rpc("platform_leave_history_mark", { p_tenant_id: schoolId, p_ids: accepted });
      if (markError) throw new Error(`could not mark the exported leave: ${markError.message}`);
      marked += Number(n ?? 0);
    }
  }
  return { ...base, dry_run: false, count: records.length, sent, marked, refused_by_hr: refused };
}
