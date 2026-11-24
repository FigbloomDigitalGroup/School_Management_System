import { apiClient } from "./client";
import { isApiError, type ApiErrorCode } from "./errors";
import { listMemberships } from "./peopleApi";
import { settlePool } from "./pool";
import type { components } from "./schema";
import { currentAcademicYear, listClasses } from "./setupApi";

/**
 * Small reads that the activities and sick bay screens share: a learner by id, and the name of a learner's class. The API's
 * activity members and sick bay visits carry a learner id and nothing else, so names come from here. Both are readable only
 * with the People and Academics areas, so a refusal is "nothing to show" and not a failure of the page.
 */

type Learner = components["schemas"]["Learner"];

export const LOOKUP_CONCURRENCY = 4;

/** Runs a read the person may not be allowed: the codes named (a refusal by default) give `fallback`; any other failure still fails. */
export async function tolerantRead<T>(read: () => Promise<T>, fallback: T, codes: readonly ApiErrorCode[] = ["forbidden"]): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isApiError(err) && codes.includes(err.code)) return fallback;
    throw err;
  }
}

/** learner id -> the name of their class this year, for every learner in a class of the current year. */
export async function classNameByLearner(tenantId: string): Promise<Map<string, string>> {
  const year = await currentAcademicYear(tenantId);
  if (!year) return new Map();
  const [classes, memberships] = await Promise.all([listClasses(tenantId, year.id), listMemberships(tenantId)]);
  const names = new Map(classes.map((c) => [c.id, c.name]));
  const out = new Map<string, string>();
  for (const m of memberships) {
    const name = names.get(m.class_id);
    if (name) out.set(m.learner_id, name);
  }
  return out;
}

/** The same for a few learners only: the year's classes once, then each learner's own memberships, so a short list costs a few calls. */
export async function classNamesFor(tenantId: string, learnerIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (learnerIds.length === 0) return out;
  const year = await currentAcademicYear(tenantId);
  if (!year) return out;
  const classes = await listClasses(tenantId, year.id);
  const names = new Map(classes.map((c) => [c.id, c.name]));
  const settled = await settlePool(learnerIds, LOOKUP_CONCURRENCY, (learnerId) => listMemberships(tenantId, learnerId));
  settled.forEach((s, i) => {
    if (!s.ok) {
      if (isApiError(s.error) && s.error.code === "forbidden") return;
      throw s.error;
    }
    const m = s.value.find((x) => x.academic_year_id === year.id && names.has(x.class_id));
    if (m) out.set(learnerIds[i]!, names.get(m.class_id)!);
  });
  return out;
}

/** One learner by id; null when the person may not read learners or the learner is not in this school. */
export async function fetchLearnerById(tenantId: string, learnerId: string): Promise<Learner | null> {
  return tolerantRead(async () => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/learners/{learnerId}", { path: { tenantId, learnerId }, tenantId });
    return r.learner;
  }, null, ["forbidden", "not_found"]);
}

/** Several learners by id, a few at once, keyed by id. Ones that cannot be read are left out. */
export async function fetchLearnersById(tenantId: string, learnerIds: readonly string[]): Promise<Map<string, Learner>> {
  const unique = [...new Set(learnerIds)];
  const settled = await settlePool(unique, LOOKUP_CONCURRENCY, (id) => fetchLearnerById(tenantId, id));
  const out = new Map<string, Learner>();
  settled.forEach((s, i) => {
    if (!s.ok) throw s.error;
    if (s.value) out.set(unique[i]!, s.value);
  });
  return out;
}
