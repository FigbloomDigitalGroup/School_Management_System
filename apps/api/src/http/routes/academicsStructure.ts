import type { FastifyInstance } from "fastify";
import { calendarDateString } from "../schemas.js";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  archiveClassMembership,
  assignLearnerToClass,
  createAcademicYear,
  createClass,
  createSubject,
  createTeachingAssignment,
  createTerm,
  createTimetablePublication,
  createTimetableSlot,
  getAcademicYearById,
  findClassInScope,
  getClassById,
  getClassMembershipById,
  getSubjectById,
  getTeachingAssignmentById,
  getTermById,
  getTimetableSlotById,
  listAcademicYears,
  listClassMemberships,
  listClasses,
  listSubjects,
  listTeachingAssignments,
  listTerms,
  listTimetablePublications,
  listTimetableSlots,
  publishTimetablePublication,
  setCurrentAcademicYear,
  setCurrentTerm,
} from "../../modules/academics/structure.js";
import { AppError, notFound, validationError } from "../errors.js";
import { assertUuid, calendarReadScope, classReadScope, inTenant, optionalBool, optionalUuid, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const DateString = calendarDateString;
const TimeString = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

const YearBody = z.strictObject({
  label: z.string().min(1).max(32),
  starts_on: DateString,
  ends_on: DateString,
  is_current: z.boolean().optional(),
});
const TermBody = z.strictObject({
  academic_year_id: z.guid(),
  index: z.number().int().min(1).max(4),
  label: z.string().min(1).max(64),
  starts_on: DateString,
  ends_on: DateString,
  is_current: z.boolean().optional(),
});
const SubjectBody = z.strictObject({ code: z.string().min(1).max(32), name: z.string().min(1).max(120) });
const EducationLevel = z.enum([
  "pre_primary",
  "primary",
  "junior_secondary",
  "senior_school",
  "secondary",
]);
const Pathway = z.enum(["stem", "social_sciences", "arts_sports"]);
const ClassBody = z.strictObject({
  academic_year_id: z.guid(),
  name: z.string().min(1).max(64),
  form_level: z.number().int().min(1).max(12).nullable().optional(),
  education_level: EducationLevel.nullable().optional(),
  pathway: Pathway.nullable().optional(),
  stream: z.string().min(1).max(32).nullable().optional(),
  class_teacher_staff_id: z.guid().nullable().optional(),
});
const MembershipBody = z.strictObject({ learner_id: z.guid(), class_id: z.guid() });
const AssignmentBody = z.strictObject({
  staff_member_id: z.guid(),
  class_id: z.guid(),
  subject_id: z.guid(),
});
const SlotBody = z.strictObject({
  class_id: z.guid(),
  subject_id: z.guid(),
  teaching_assignment_id: z.guid().nullable().optional(),
  day_of_week: z.number().int().min(1).max(7),
  starts_at: TimeString,
  ends_at: TimeString,
  room: z.string().min(1).max(64).nullable().optional(),
});

/** Request bodies by OpenAPI operation key; test/openapi.stage910.contract.test.ts compares them with the spec. */
export const STRUCTURE_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/academic-years": YearBody,
  "POST /v1/tenants/{tenantId}/academic-terms": TermBody,
  "POST /v1/tenants/{tenantId}/subjects": SubjectBody,
  "POST /v1/tenants/{tenantId}/classes": ClassBody,
  "POST /v1/tenants/{tenantId}/class-memberships": MembershipBody,
  "POST /v1/tenants/{tenantId}/teaching-assignments": AssignmentBody,
  "POST /v1/tenants/{tenantId}/timetable-slots": SlotBody,
  "POST /v1/tenants/{tenantId}/timetable-publications": z.strictObject({ class_id: z.guid(), term_id: z.guid().nullable().optional() }),
} as const;

export async function registerAcademicsStructureRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/academic-years", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(YearBody, request.body, "label, starts_on and ends_on are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/academic-years",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const academic_year = await createAcademicYear(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { academic_year }, resourceType: "academic_year", resourceId: academic_year.id };
        },
        replay: async (_t, id) => {
          try {
            return { academic_year: await getAcademicYearById(tx, { tenantId: params.tenantId, academicYearId: id }) };
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 404) return null;
            throw err;
          }
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/academic-years", async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      // Teacher reads (docs/TEACHER-READS.md): academics readers see every year; a teacher sees the years of their classes.
      const scopeYearIds = await calendarReadScope(tx, auth, ip);
      const out = await listAcademicYears(tx, { tenantId: params.tenantId, page, scopeYearIds });
      return { academic_years: out.items, page: out.page };
    });
  });

  app.get("/v1/tenants/:tenantId/academic-years/:academicYearId", async (request) => {
    const params = request.params as { tenantId: string; academicYearId: string };
    assertUuid(params.academicYearId, "academicYearId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await calendarReadScope(tx, auth, ip);
      if (scope !== null && !scope.includes(params.academicYearId)) throw notFound("Academic year not found");
      return { academic_year: await getAcademicYearById(tx, { tenantId: params.tenantId, academicYearId: params.academicYearId }) };
    });
  });

  app.post("/v1/tenants/:tenantId/academic-years/:academicYearId/set-current", async (request, reply) => {
    const params = request.params as { tenantId: string; academicYearId: string };
    assertUuid(params.academicYearId, "academicYearId");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/academic-years/:academicYearId/set-current",
        fingerprintInput: { params },
        status: 200,
        execute: async () => {
          const academic_year = await setCurrentAcademicYear(tx, {
            tenantId: params.tenantId,
            academicYearId: params.academicYearId,
            actorUserId: auth.user.id,
            ip,
          });
          return { value: { academic_year }, resourceType: "academic_year", resourceId: academic_year.id };
        },
        replay: async () => ({ academic_year: await getAcademicYearById(tx, { tenantId: params.tenantId, academicYearId: params.academicYearId }) }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.post("/v1/tenants/:tenantId/academic-terms", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(TermBody, request.body, "academic_year_id, index, label, starts_on and ends_on are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/academic-terms",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const term = await createTerm(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { term }, resourceType: "academic_term", resourceId: term.id };
        },
        replay: async (_t, id) => {
          try {
            return { term: await getTermById(tx, { tenantId: params.tenantId, termId: id }) };
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 404) return null;
            throw err;
          }
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/academic-terms", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const academicYearId = optionalUuid(query.academicYearId, "academicYearId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      // Teacher reads (docs/TEACHER-READS.md): a teacher sees the terms of the years of their classes.
      const scopeYearIds = await calendarReadScope(tx, auth, ip);
      const out = await listTerms(tx, { tenantId: params.tenantId, academicYearId, page, scopeYearIds });
      return { terms: out.items, page: out.page };
    });
  });

  app.get("/v1/tenants/:tenantId/academic-terms/:termId", async (request) => {
    const params = request.params as { tenantId: string; termId: string };
    assertUuid(params.termId, "termId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await calendarReadScope(tx, auth, ip);
      const term = await getTermById(tx, { tenantId: params.tenantId, termId: params.termId });
      // Outside the teacher's years: the same 404 as a term that does not exist.
      if (scope !== null && !scope.includes(term.academic_year_id)) throw notFound("Term not found");
      return { term };
    });
  });

  app.post("/v1/tenants/:tenantId/academic-terms/:termId/set-current", async (request, reply) => {
    const params = request.params as { tenantId: string; termId: string };
    assertUuid(params.termId, "termId");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/academic-terms/:termId/set-current",
        fingerprintInput: { params },
        status: 200,
        execute: async () => {
          const term = await setCurrentTerm(tx, { tenantId: params.tenantId, termId: params.termId, actorUserId: auth.user.id, ip });
          return { value: { term }, resourceType: "academic_term", resourceId: term.id };
        },
        replay: async () => ({ term: await getTermById(tx, { tenantId: params.tenantId, termId: params.termId }) }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.post("/v1/tenants/:tenantId/subjects", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(SubjectBody, request.body, "code and name are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/subjects",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const subject = await createSubject(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { subject }, resourceType: "subject", resourceId: subject.id };
        },
        replay: async (_t, id) => {
          try {
            return { subject: await getSubjectById(tx, { tenantId: params.tenantId, subjectId: id }) };
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 404) return null;
            throw err;
          }
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/subjects", async (request) => {
    const params = request.params as { tenantId: string };
    const active = optionalBool((request.query as { active?: unknown }).active, "active");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const out = await listSubjects(tx, { tenantId: params.tenantId, active, page });
      return { subjects: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/classes", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(ClassBody, request.body, "academic_year_id and name are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/classes",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const school_class = await createClass(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { school_class }, resourceType: "class", resourceId: school_class.id };
        },
        replay: async (_t, id) => {
          try {
            return { school_class: await getClassById(tx, { tenantId: params.tenantId, classId: id }) };
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 404) return null;
            throw err;
          }
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/classes", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const academicYearId = optionalUuid(query.academicYearId, "academicYearId");
    const active = optionalBool(query.active, "active");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await classReadScope(tx, auth, ip, "resource.academics.read");
      const out = await listClasses(tx, {
        tenantId: params.tenantId,
        academicYearId,
        active,
        page,
        scopeClassIds: scope,
      });
      return { classes: out.items, page: out.page };
    });
  });

  app.get("/v1/tenants/:tenantId/classes/:classId", async (request) => {
    const params = request.params as { tenantId: string; classId: string };
    assertUuid(params.classId, "classId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await classReadScope(tx, auth, ip, "resource.academics.read");
      const school_class = await findClassInScope(tx, {
        tenantId: params.tenantId,
        classId: params.classId,
        scopeClassIds: scope,
      });
      if (!school_class) throw notFound("Class not found");
      return { school_class };
    });
  });

  app.post("/v1/tenants/:tenantId/class-memberships", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(MembershipBody, request.body, "learner_id and class_id are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/class-memberships",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const membership = await assignLearnerToClass(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { membership }, resourceType: "class_membership", resourceId: membership.id };
        },
        replay: async (_t, id) => {
          const membership = await getClassMembershipById(tx, { tenantId: params.tenantId, membershipId: id });
          return membership ? { membership } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/class-memberships", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await classReadScope(tx, auth, ip, "resource.academics.read");
      const out = await listClassMemberships(tx, {
        tenantId: params.tenantId,
        classId: optionalUuid(query.classId, "classId"),
        learnerId: optionalUuid(query.learnerId, "learnerId"),
        active: optionalBool(query.active, "active"),
        page,
        scopeClassIds: scope,
      });
      return { memberships: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/class-memberships/:membershipId/archive", async (request, reply) => {
    const params = request.params as { tenantId: string; membershipId: string };
    assertUuid(params.membershipId, "membershipId");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/class-memberships/:membershipId/archive",
        fingerprintInput: { params },
        status: 200,
        execute: async () => {
          const membership = await archiveClassMembership(tx, {
            tenantId: params.tenantId,
            membershipId: params.membershipId,
            actorUserId: auth.user.id,
            ip,
          });
          return { value: { membership }, resourceType: "class_membership", resourceId: membership.id };
        },
        replay: async () => {
          const membership = await getClassMembershipById(tx, { tenantId: params.tenantId, membershipId: params.membershipId });
          return membership ? { membership } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.post("/v1/tenants/:tenantId/teaching-assignments", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(AssignmentBody, request.body, "staff_member_id, class_id and subject_id are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/teaching-assignments",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const assignment = await createTeachingAssignment(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { assignment }, resourceType: "teaching_assignment", resourceId: assignment.id };
        },
        replay: async (_t, id) => {
          const assignment = await getTeachingAssignmentById(tx, { tenantId: params.tenantId, assignmentId: id });
          return assignment ? { assignment } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/teaching-assignments", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await classReadScope(tx, auth, ip, "resource.academics.read");
      const out = await listTeachingAssignments(tx, {
        tenantId: params.tenantId,
        classId: optionalUuid(query.classId, "classId"),
        staffMemberId: optionalUuid(query.staffMemberId, "staffMemberId"),
        active: optionalBool(query.active, "active"),
        page,
        scopeClassIds: scope,
      });
      return { assignments: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/timetable-slots", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(SlotBody, request.body, "class_id, subject_id, day_of_week, starts_at and ends_at are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/timetable-slots",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const slot = await createTimetableSlot(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          return { value: { slot }, resourceType: "timetable_slot", resourceId: slot.id };
        },
        replay: async (_t, id) => {
          const slot = await getTimetableSlotById(tx, { tenantId: params.tenantId, slotId: id });
          return slot ? { slot } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/timetable-slots", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const classId = optionalUuid(query.classId, "classId");
    if (!classId) throw validationError("classId is required");
    const active = optionalBool(query.active, "active");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await classReadScope(tx, auth, ip, "resource.academics.read");
      const out = await listTimetableSlots(tx, {
        tenantId: params.tenantId,
        classId,
        active,
        page,
        scopeClassIds: scope,
      });
      return { slots: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/timetable-publications", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(
      STRUCTURE_REQUEST_SCHEMAS["POST /v1/tenants/{tenantId}/timetable-publications"],
      request.body,
      "class_id is required",
    );
    const publication = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      return createTimetablePublication(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
    });
    return reply.status(201).send({ publication });
  });

  app.post("/v1/tenants/:tenantId/timetable-publications/:publicationId/publish", async (request) => {
    const params = request.params as { tenantId: string; publicationId: string };
    assertUuid(params.publicationId, "publicationId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.write", { ip, deferAudit: true });
      const publication = await publishTimetablePublication(tx, {
        tenantId: params.tenantId,
        publicationId: params.publicationId,
        actorUserId: auth.user.id,
        ip,
      });
      return { publication };
    });
  });

  app.get("/v1/tenants/:tenantId/timetable-publications", async (request) => {
    const params = request.params as { tenantId: string };
    const classId = optionalUuid((request.query as { classId?: unknown }).classId, "classId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const scope = await classReadScope(tx, auth, ip, "resource.academics.read");
      const out = await listTimetablePublications(tx, {
        tenantId: params.tenantId,
        classId,
        scopeClassIds: scope,
        page,
      });
      return { publications: out.items, page: out.page };
    });
  });
}
