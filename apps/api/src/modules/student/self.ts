import type { Tx } from "../../db/sql.js";
import { attachDenialAudit } from "../../db/errors.js";
import { notFound } from "../../http/errors.js";
import { currentClasses, type ChildClass } from "../family/children.js";

/**
 * A learner's own records (docs/STUDENT-ACCOUNTS.md). "My learner" is decided only by `student_my_learner()` (migration
 * 110), a definer function that reads the owner-only learner_accounts with the user and school the server set for this
 * transaction: a live login link, an active account, a `student` membership of this school, an active learner. Nothing here
 * takes a user id from the client, and nothing is cached between requests.
 */
export const LEARNER_NOT_FOUND = "Learner not found";

export async function myOwnLearner(tx: Tx): Promise<{ learner_id: string; login_id: string | null } | null> {
  const res = await tx.query<{ learner_id: string; login_id: string | null }>(`SELECT learner_id, login_id FROM public.student_my_learner()`);
  return res.rows[0] ?? null;
}

/** True when `learnerId` is the caller's own live learner in the school of this transaction. */
export async function isMyOwnLearner(tx: Tx, learnerId: string): Promise<boolean> {
  const own = await myOwnLearner(tx);
  return own !== null && own.learner_id === learnerId;
}

/**
 * The gate of every per-learner read a student makes: 404 for every other learner (a classmate, another school's learner,
 * an id that does not exist) and for every way the caller's own link stops being live (revoked link, archived learner,
 * archived membership). Audited as `student.learner.denied` after the rollback, like a permission denial.
 */
export async function assertMyOwnLearner(
  tx: Tx,
  input: { learnerId: string; actorUserId: string; tenantId: string; ip?: string | null },
): Promise<void> {
  if (await isMyOwnLearner(tx, input.learnerId)) return;
  const err = notFound(LEARNER_NOT_FOUND);
  attachDenialAudit(err, {
    eventType: "student.learner.denied",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { learnerId: input.learnerId },
    ip: input.ip ?? null,
  });
  throw err;
}

export interface MyLearner {
  learner_id: string;
  full_name: string;
  admission_no: string;
  boarding: boolean;
  login_id: string | null;
  /** The learner's class in the current academic year (active membership of an active class), or null. */
  class: ChildClass | null;
}

/** The signed-in learner's own record, or a 404 when the caller has no live learner here. */
export async function getMyLearner(tx: Tx, tenantId: string): Promise<MyLearner> {
  const own = await myOwnLearner(tx);
  if (!own) throw notFound(LEARNER_NOT_FOUND);
  const res = await tx.query<{ id: string; full_name: string; admission_no: string; boarding: boolean }>(
    `SELECT id, full_name, admission_no, boarding FROM learners WHERE tenant_id = $1 AND id = $2`,
    [tenantId, own.learner_id],
  );
  const l = res.rows[0];
  if (!l) throw notFound(LEARNER_NOT_FOUND);
  const classes = await currentClasses(tx, tenantId, [l.id]);
  return {
    learner_id: l.id,
    full_name: l.full_name,
    admission_no: l.admission_no,
    boarding: l.boarding,
    login_id: own.login_id,
    class: classes.get(l.id) ?? null,
  };
}
