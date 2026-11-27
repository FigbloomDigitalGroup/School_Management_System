import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import {
  createHeCourse,
  createHeEnrolment,
  createHeSection,
  createOnlinePaper,
  archiveOnlinePaper,
  correctHeGrade,
  getHeGradeForEnrolment,
  getHeGradeVersion,
  listHeGradeRevisions,
  getHeCourseById,
  getHeEnrolmentById,
  getHeSectionById,
  getOnlinePaperById,
  getOnlineAttempt,
  listHeCourses,
  listHeEnrolments,
  listHeSections,
  listOnlinePapers,
  recordHeGrade,
  publishOnlinePaper,
  startOnlineAttempt,
  submitOnlineAttempt,
  updateHeSectionInstructor,
  updateOnlinePaper,
} from "../../modules/academics/higherEd.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { getLiveKitProvider } from "../../modules/communications/livekitProvider.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { startMyAttempt, submitMyAttempt } from "../../modules/student/exams.js";
import { assertMyOwnLearner, LEARNER_NOT_FOUND, myOwnLearner } from "../../modules/student/self.js";
import type { Tx } from "../../db/sql.js";
import { notFound } from "../errors.js";
import type { RequestAuth } from "../middleware/authContext.js";
import { assertUuid, inTenant, optionalUuid, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";
import { STUDENT_SELF_READ } from "./family.js";

/**
 * Student accounts (docs/STUDENT-ACCOUNTS.md, owner decision 4): a `student` member reaches the two attempt endpoints for
 * their OWN learner only (a published paper of their own class; their own attempt), never with a score. Returns the
 * caller's own learner id for a student, null for anyone else (who keeps the `resource.academics.write` rule).
 */
async function studentSitter(tx: Tx, auth: RequestAuth, ip: string | null): Promise<string | null> {
  if (auth.authz.membership?.role !== "student") return null;
  await requirePermission(tx, auth.authz, STUDENT_SELF_READ, { ip, deferAudit: true });
  const own = await myOwnLearner(tx);
  if (!own) throw notFound(LEARNER_NOT_FOUND);
  return own.learner_id;
}

const CourseBody = z.strictObject({
  code: z.string().min(1).max(32),
  title: z.string().min(1).max(160),
  credit_hours: z.number().positive().optional(),
});
const SectionBody = z.strictObject({
  course_id: z.guid(),
  term_id: z.guid(),
  label: z.string().min(1).max(32),
  /** A staff record of this school (a lecturer). Optional: a section may have none yet. */
  instructor_staff_id: z.guid().nullable().optional(),
});
/** Name or change the instructor of a section; `null` clears it. */
const SectionPatch = z.strictObject({ instructor_staff_id: z.guid().nullable() });
const EnrolBody = z.strictObject({ section_id: z.guid(), learner_id: z.guid() });
const GradeBody = z.strictObject({ score: z.number(), grade: z.string().max(16).nullable().optional() });
const GradeCorrectionBody = z.strictObject({
  score: z.number(),
  grade: z.string().max(16).nullable().optional(),
  reason: z.string().min(5).max(500),
  row_version: z.number().int().positive(),
});
const QuestionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  prompt: z.string().min(1).max(1000),
  kind: z.enum(["mcq", "true_false"]),
  options: z.array(z.string().min(1).max(200)).optional(),
  correct_answer: z.string().min(1).max(200),
  points: z.number().positive().max(1000),
});
const PaperBody = z.strictObject({
  class_id: z.guid(),
  subject_id: z.guid(),
  title: z.string().min(1).max(160),
  max_score: z.number().positive(),
  questions: z.array(QuestionSchema).nullable().optional(),
});
const PaperPatch = z.strictObject({
  title: z.string().min(1).max(160).optional(),
  max_score: z.number().positive().max(10000).optional(),
  questions: z.array(QuestionSchema).nullable().optional(),
}).refine((body) => Object.keys(body).length > 0, "At least one exam paper field is required");
const AttemptBody = z.strictObject({ learner_id: z.guid() });
const SubmitBody = z.strictObject({
  score: z.number().optional(),
  answers: z.record(z.string(), z.string()).optional(),
});

/** Request bodies by OpenAPI operation key; test/openapi.stage910.contract.test.ts compares them with the spec. */
export const HIGHER_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/he-courses": CourseBody,
  "POST /v1/tenants/{tenantId}/he-sections": SectionBody,
  "PATCH /v1/tenants/{tenantId}/he-sections/{sectionId}": SectionPatch,
  "POST /v1/tenants/{tenantId}/he-enrolments": EnrolBody,
  "POST /v1/tenants/{tenantId}/he-enrolments/{enrolmentId}/grade": GradeBody,
  "POST /v1/tenants/{tenantId}/he-enrolments/{enrolmentId}/grade-corrections": GradeCorrectionBody,
  "POST /v1/tenants/{tenantId}/online-exam-papers": PaperBody,
  "PATCH /v1/tenants/{tenantId}/online-exam-papers/{paperId}": PaperPatch,
  "POST /v1/tenants/{tenantId}/online-exam-papers/{paperId}/attempts": AttemptBody,
  "POST /v1/tenants/{tenantId}/online-exam-attempts/{attemptId}/submit": SubmitBody,
} as const;

export async function registerAcademicsHigherRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/he-courses", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(CourseBody, request.body, "code and title are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/he-courses",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const course = await createHeCourse(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { course }, resourceType: "he_course", resourceId: course.id };
        },
        replay: async (_t, id) => {
          const course = await getHeCourseById(tx, { tenantId: params.tenantId, id });
          return course ? { course } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/he-courses", async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listHeCourses(tx, { tenantId: params.tenantId, page: pageFrom(request) });
      return { courses: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/he-sections", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(SectionBody, request.body, "course_id, term_id and label are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/he-sections",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const section = await createHeSection(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { section }, resourceType: "he_section", resourceId: section.id };
        },
        replay: async (_t, id) => {
          const section = await getHeSectionById(tx, { tenantId: params.tenantId, id });
          return section ? { section } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  // Name, change or clear (null) a section's instructor. Same permission as creating a section. Naturally idempotent, so no key.
  app.patch("/v1/tenants/:tenantId/he-sections/:sectionId", async (request) => {
    const params = request.params as { tenantId: string; sectionId: string };
    assertUuid(params.sectionId, "sectionId");
    const parsed = parseOrThrow(SectionPatch, request.body, "instructor_staff_id is required (a staff id, or null to clear it)");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      const section = await updateHeSectionInstructor(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        sectionId: params.sectionId,
        instructor_staff_id: parsed.instructor_staff_id,
        ip,
      });
      return { section };
    });
  });

  app.get("/v1/tenants/:tenantId/he-sections", async (request) => {
    const params = request.params as { tenantId: string };
    const courseId = optionalUuid((request.query as { courseId?: unknown }).courseId, "courseId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listHeSections(tx, { tenantId: params.tenantId, courseId, page: pageFrom(request) });
      return { sections: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/he-enrolments", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(EnrolBody, request.body, "section_id and learner_id are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/he-enrolments",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const enrolment = await createHeEnrolment(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { enrolment }, resourceType: "he_enrolment", resourceId: enrolment.id };
        },
        replay: async (_t, id) => {
          const enrolment = await getHeEnrolmentById(tx, { tenantId: params.tenantId, id });
          return enrolment ? { enrolment } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/he-enrolments", async (request) => {
    const params = request.params as { tenantId: string };
    const sectionId = optionalUuid((request.query as { sectionId?: unknown }).sectionId, "sectionId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listHeEnrolments(tx, { tenantId: params.tenantId, sectionId, page: pageFrom(request) });
      return { enrolments: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/he-enrolments/:enrolmentId/grade", async (request, reply) => {
    const params = request.params as { tenantId: string; enrolmentId: string };
    assertUuid(params.enrolmentId, "enrolmentId");
    const parsed = parseOrThrow(GradeBody, request.body, "score is required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/he-enrolments/:enrolmentId/grade",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const done = await recordHeGrade(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            enrolmentId: params.enrolmentId,
            ...parsed,
            ip,
          });
          // OD-5: 201 for a first grade, 200 for an identical resend. Replays return the original version.
          return {
            value: { grade: done.grade, outcome: done.outcome },
            resourceType: `${done.ref.type}:${done.outcome}`,
            resourceId: done.ref.id,
            status: done.outcome === "created" ? 201 : 200,
          };
        },
        replay: async (refType, id) => {
          const [type, outcome] = refType.split(":");
          const grade = await getHeGradeVersion(tx, { tenantId: params.tenantId, refType: type ?? "", refId: id });
          return grade ? { grade, outcome: (outcome ?? "created") as "created" | "unchanged" } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/he-enrolments/:enrolmentId/grade", async (request) => {
    const params = request.params as { tenantId: string; enrolmentId: string };
    assertUuid(params.enrolmentId, "enrolmentId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      return { grade: await getHeGradeForEnrolment(tx, { tenantId: params.tenantId, enrolmentId: params.enrolmentId }) };
    });
  });

  // OD-5: authorised correction of an existing grade (also on a withdrawn enrolment). Never creates a first grade.
  app.post("/v1/tenants/:tenantId/he-enrolments/:enrolmentId/grade-corrections", async (request, reply) => {
    const params = request.params as { tenantId: string; enrolmentId: string };
    assertUuid(params.enrolmentId, "enrolmentId");
    const parsed = parseOrThrow(GradeCorrectionBody, request.body, "score, reason and row_version are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/he-enrolments/:enrolmentId/grade-corrections",
        fingerprintInput: { params, body: parsed },
        status: 200,
        execute: async () => {
          const done = await correctHeGrade(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            enrolmentId: params.enrolmentId,
            score: parsed.score,
            grade: parsed.grade,
            reason: parsed.reason,
            rowVersion: parsed.row_version,
            ip,
          });
          return { value: { grade: done.grade }, resourceType: done.ref.type, resourceId: done.ref.id };
        },
        replay: async (refType, id) => {
          const grade = await getHeGradeVersion(tx, { tenantId: params.tenantId, refType, refId: id });
          return grade ? { grade } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/he-enrolments/:enrolmentId/grade-revisions", async (request) => {
    const params = request.params as { tenantId: string; enrolmentId: string };
    assertUuid(params.enrolmentId, "enrolmentId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listHeGradeRevisions(tx, { tenantId: params.tenantId, enrolmentId: params.enrolmentId, page });
      return { revisions: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/online-exam-papers", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(PaperBody, request.body, "class_id, subject_id, title and max_score are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/online-exam-papers",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const paper = await createOnlinePaper(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { paper }, resourceType: "online_exam_paper", resourceId: paper.id };
        },
        replay: async (_t, id) => {
          const paper = await getOnlinePaperById(tx, { tenantId: params.tenantId, id });
          return paper ? { paper } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/online-exam-papers", async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listOnlinePapers(tx, { tenantId: params.tenantId, page: pageFrom(request) });
      return { papers: out.items, page: out.page };
    });
  });

  app.patch("/v1/tenants/:tenantId/online-exam-papers/:paperId", async (request) => {
    const params = request.params as { tenantId: string; paperId: string };
    assertUuid(params.paperId, "paperId");
    const parsed = parseOrThrow(PaperPatch, request.body, "at least one exam paper field is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      const paper = await updateOnlinePaper(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, paperId: params.paperId, ...parsed, ip });
      return { paper };
    });
  });

  app.post("/v1/tenants/:tenantId/online-exam-papers/:paperId/archive", async (request, reply) => {
    const params = request.params as { tenantId: string; paperId: string };
    assertUuid(params.paperId, "paperId");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/online-exam-papers/:paperId/archive",
        fingerprintInput: { params },
        status: 200,
        execute: async () => {
          const paper = await archiveOnlinePaper(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, paperId: params.paperId, ip });
          return { value: { paper }, resourceType: "online_exam_paper_archived", resourceId: paper.id };
        },
        replay: async () => {
          const paper = await getOnlinePaperById(tx, { tenantId: params.tenantId, id: params.paperId });
          return paper ? { paper } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  // Migration 110 (docs/STUDENT-ACCOUNTS.md): learners of the paper's class see it only once it is published. Naturally
  // idempotent (publishing twice keeps the first time), so no key.
  app.post("/v1/tenants/:tenantId/online-exam-papers/:paperId/publish", async (request) => {
    const params = request.params as { tenantId: string; paperId: string };
    assertUuid(params.paperId, "paperId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return { paper: await publishOnlinePaper(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, paperId: params.paperId, ip }) };
    });
  });

  app.post("/v1/tenants/:tenantId/online-exam-papers/:paperId/attempts", async (request, reply) => {
    const params = request.params as { tenantId: string; paperId: string };
    assertUuid(params.paperId, "paperId");
    const parsed = parseOrThrow(AttemptBody, request.body, "learner_id is required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const own = await studentSitter(tx, auth, ip);
      if (own !== null) {
        // A learner starts their own attempt only: any other learner id is the audited 404 of every per-learner read.
        await assertMyOwnLearner(tx, { learnerId: parsed.learner_id, actorUserId: auth.user.id, tenantId: params.tenantId, ip });
        const attempt = await startMyAttempt(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, learnerId: own, paperId: params.paperId, ip });
        return { replayed: false, status: 201, value: { attempt } };
      }
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/online-exam-papers/:paperId/attempts",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const attempt = await startOnlineAttempt(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            paperId: params.paperId,
            learner_id: parsed.learner_id,
            ip,
          });
          return { value: { attempt }, resourceType: "online_exam_attempt", resourceId: attempt.id };
        },
        replay: async (_t, id) => {
          const found = await getOnlineAttempt(tx, { tenantId: params.tenantId, attemptId: id });
          if (!found) return null;
          const { mark: _mark, ...attempt } = found;
          return { attempt };
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.post("/v1/tenants/:tenantId/online-exam-attempts/:attemptId/submit", async (request, reply) => {
    const params = request.params as { tenantId: string; attemptId: string };
    assertUuid(params.attemptId, "attemptId");
    const parsed = parseOrThrow(SubmitBody, request.body, "score or answers is required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const own = await studentSitter(tx, auth, ip);
      if (own !== null) {
        // The learner's own attempt only (another learner's attempt is a 404), answers only (a score is a 403), no mark back.
        const attempt = await submitMyAttempt(tx, {
          tenantId: params.tenantId,
          actorUserId: auth.user.id,
          learnerId: own,
          attemptId: params.attemptId,
          answers: parsed.answers,
          score: parsed.score,
          ip,
        });
        return { replayed: false, status: 200, value: { attempt } };
      }
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/online-exam-attempts/:attemptId/submit",
        fingerprintInput: { params, body: parsed },
        status: 200,
        execute: async () => {
          const attempt = await submitOnlineAttempt(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            attemptId: params.attemptId,
            score: parsed.score,
            answers: parsed.answers,
            ip,
          });
          return { value: { attempt }, resourceType: "online_exam_attempt", resourceId: attempt.id };
        },
        replay: async (_t, id) => {
          const found = await getOnlineAttempt(tx, { tenantId: params.tenantId, attemptId: id });
          if (!found || !found.mark || found.submitted_at === null) return null;
          return { attempt: { id: found.id, status: found.status, submitted_at: found.submitted_at, auto_marked: false, mark: found.mark } };
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.post("/v1/tenants/:tenantId/live-classes/token", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(
      z.strictObject({
        room_name: z.string().min(1).max(120),
        role: z.enum(["host", "participant"]).optional(),
      }),
      request.body,
      "room_name is required",
    );
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      return getLiveKitProvider().createRoomToken({
        tenantId: params.tenantId,
        roomName: body.room_name,
        participantIdentity: auth.user.id,
        participantName: auth.user.full_name ?? auth.user.id,
        role: body.role ?? "participant",
      });
    });
    if (out.status === "not_configured") return reply.status(503).send(out);
    return reply.status(200).send(out);
  });
}
