import { apiClient } from "./client";
import { settlePool } from "./pool";

/** Bound per-row reads to the visible People page, so large schools don't issue unbounded requests. */
export const STUDENT_ACCOUNT_STATUS_CONCURRENCY = 4;

/** Login id by learner id. A null value means that learner has no login. */
export async function apiFetchStudentAccountStatuses(tenantId: string, learnerIds: readonly string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(learnerIds)];
  const reads = await settlePool(ids, STUDENT_ACCOUNT_STATUS_CONCURRENCY, async (learnerId) => {
    const { account } = await apiClient().get("/v1/tenants/{tenantId}/learners/{learnerId}/student-account", {
      path: { tenantId, learnerId }, tenantId,
    });
    return { learnerId, loginId: account.login_id };
  });
  const failed = reads.find((read): read is { ok: false; error: unknown } => !read.ok);
  if (failed) throw failed.error;
  return new Map(reads.flatMap((read) => read.ok ? [[read.value.learnerId, read.value.loginId] as const] : []));
}

/** Creates one learner login; the one-time password is returned to the caller once and never persisted here. */
export async function apiCreateStudentAccount(tenantId: string, learnerId: string): Promise<{ ok: true; login_id: string; password: string }> {
  const { account } = await apiClient().post("/v1/tenants/{tenantId}/learners/{learnerId}/student-account", {
    path: { tenantId, learnerId }, tenantId,
  });
  return { ok: true, login_id: account.login_id, password: account.one_time_password };
}
