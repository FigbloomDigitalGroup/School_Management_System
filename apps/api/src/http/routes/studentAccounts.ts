import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import type { Tx } from "../../db/sql.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  createStudentAccount,
  resetStudentPassword,
  revokeStudentAccount,
  studentAccountStatus,
} from "../../modules/student/accounts.js";
import { getMyAttempt, listMyOnlineExams, saveMyAnswers } from "../../modules/student/exams.js";
import { getMyLearner, LEARNER_NOT_FOUND, myOwnLearner } from "../../modules/student/self.js";
import { notFound } from "../errors.js";
import type { RequestAuth } from "../middleware/authContext.js";
import { assertUuid, inTenant } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";
import { STUDENT_SELF_READ } from "./family.js";

/**
 * Student accounts (docs/STUDENT-ACCOUNTS.md, migration 110).
 *
 * The school office (a school administrator, or a teacher/staff member holding the People area: `resource.learner.write`,
 * re-checked in the database, which also refuses organisation administrators) makes, resets and revokes a learner's login
 * and reads its status. The one-time password is in the create and reset answers only, once.
 *
 * A signed-in learner (`resource.student.self.read`) reads their own record and their own online exams here; every other
 * read of their own records is the shared per-learner path `/me/children/{learnerId}/...` (routes/family.ts).
 */
const OFFICE = "resource.learner.write" as const;
const A = "/v1/tenants/:tenantId/learners/:learnerId/student-account";
const ME = "/v1/tenants/:tenantId/me/learner";

const RevokeBody = z.strictObject({ reason: z.string().min(3).max(300) });
const AnswersBody = z.strictObject({ answers: z.record(z.string().min(1).max(64), z.string().max(1000)) });

export const STUDENT_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/learners/{learnerId}/student-account/revoke": RevokeBody,
  "PUT /v1/tenants/{tenantId}/me/learner/online-exam-attempts/{attemptId}/answers": AnswersBody,
} as const;

/** The caller's own learner id, or 404 (no live learner here: revoked link, archived learner, not a student). */
async function ownLearnerId(tx: Tx, auth: RequestAuth, ip: string | null): Promise<string> {
  await requirePermission(tx, auth.authz, STUDENT_SELF_READ, { ip, deferAudit: true });
  const own = await myOwnLearner(tx);
  if (!own) throw notFound(LEARNER_NOT_FOUND);
  return own.learner_id;
}

export async function registerStudentAccountRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  // ------------------------------------------------------------------ the school office
  app.get(A, async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    assertUuid(params.learnerId, "learnerId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, OFFICE, { ip, deferAudit: true });
      return { account: await studentAccountStatus(tx, { tenantId: params.tenantId, learnerId: params.learnerId }) };
    });
  });

  // No Idempotency-Key replay on purpose: a replay would have to repeat the one-time password. A second create is a 409.
  app.post(A, async (request, reply) => {
    const params = request.params as { tenantId: string; learnerId: string };
    assertUuid(params.learnerId, "learnerId");
    const account = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, OFFICE, { ip, deferAudit: true });
      return createStudentAccount(tx, { tenantId: params.tenantId, learnerId: params.learnerId });
    });
    reply.header("cache-control", "no-store");
    return reply.status(201).send({ account });
  });

  app.post(`${A}/reset-password`, async (request, reply) => {
    const params = request.params as { tenantId: string; learnerId: string };
    assertUuid(params.learnerId, "learnerId");
    const account = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, OFFICE, { ip, deferAudit: true });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      return resetStudentPassword(tx, { tenantId: params.tenantId, learnerId: params.learnerId });
    });
    reply.header("cache-control", "no-store");
    return reply.status(200).send({ account });
  });

  app.post(`${A}/revoke`, async (request) => {
    const params = request.params as { tenantId: string; learnerId: string };
    assertUuid(params.learnerId, "learnerId");
    const body = parseOrThrow(RevokeBody, request.body, "a reason of 3-300 characters is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, OFFICE, { ip, deferAudit: true });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      await revokeStudentAccount(tx, { tenantId: params.tenantId, learnerId: params.learnerId, reason: body.reason });
      return { revoked: true };
    });
  });

  // ------------------------------------------------------------------ the learner
  app.get(ME, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, STUDENT_SELF_READ, { ip, deferAudit: true });
      return { learner: await getMyLearner(tx, params.tenantId) };
    });
  });

  app.get(`${ME}/online-exams`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const learnerId = await ownLearnerId(tx, auth, ip);
      return { papers: await listMyOnlineExams(tx, { tenantId: params.tenantId, learnerId }) };
    });
  });

  app.get(`${ME}/online-exam-attempts/:attemptId`, async (request) => {
    const params = request.params as { tenantId: string; attemptId: string };
    assertUuid(params.attemptId, "attemptId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const learnerId = await ownLearnerId(tx, auth, ip);
      return { attempt: await getMyAttempt(tx, { tenantId: params.tenantId, learnerId, attemptId: params.attemptId }) };
    });
  });

  app.put(`${ME}/online-exam-attempts/:attemptId/answers`, async (request) => {
    const params = request.params as { tenantId: string; attemptId: string };
    assertUuid(params.attemptId, "attemptId");
    const body = parseOrThrow(AnswersBody, request.body, "answers is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const learnerId = await ownLearnerId(tx, auth, ip);
      return { attempt: await saveMyAnswers(tx, { tenantId: params.tenantId, learnerId, attemptId: params.attemptId, answers: body.answers }) };
    });
  });
}
