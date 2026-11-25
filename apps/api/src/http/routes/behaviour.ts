import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import {
  DISCIPLINE_READ,
  DISCIPLINE_WRITE,
  addDefaultBehaviourCategories,
  behaviourScope,
  createBehaviourCategory,
  getBehaviourSettings,
  listBehaviourCategories,
  listBehaviourClasses,
  listBehaviourEntries,
  listBehaviourRecorders,
  listLearnerPoints,
  recordBehaviour,
  requireBehaviourReader,
  requireBehaviourWriter,
  saveBehaviourSettings,
  updateBehaviourCategory,
  voidBehaviourEntry,
  type BehaviourKind,
  type EntryFilters,
} from "../../modules/behaviour/behaviour.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { validationError } from "../errors.js";
import { assertUuid, inTenant, optionalBool, optionalUuid, pageFrom } from "../routeKit.js";
import { calendarDateString, isRealCalendarDate } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

/**
 * The behaviour and discipline log (docs/BEHAVIOUR.md, S2a). The office (the Discipline area) runs it; a teacher records for
 * the learners they teach and reads what they recorded and what is recorded for them. Family and learner reads are S2b.
 */
const SEVERITY = z.enum(["minor", "major", "serious"]);

const ThresholdBody = z.strictObject({
  points: z.number().int().min(-10000).max(10000).refine((n) => n !== 0, "points must not be 0"),
  label: z.string().trim().min(1).max(60),
});

const SettingsBody = z.strictObject({
  points_enabled: z.boolean(),
  mode: z.enum(["merits_only", "demerits_only", "both"]),
  starting_points: z.number().int().min(0).max(10000),
  reset: z.enum(["term", "year", "never"]),
  max_points_per_entry: z.number().int().min(1).max(100),
  thresholds: z.array(ThresholdBody).max(10),
  parents_see_demerits: z.boolean(),
  parents_see_incidents: z.boolean(),
});

const CategoryBody = z.strictObject({
  kind: z.enum(["merit", "demerit"]),
  name: z.string().trim().min(2).max(60),
  points: z.number().int().min(1).max(100),
  severity: SEVERITY.optional(),
});

const CategoryPatchBody = z
  .strictObject({
    name: z.string().trim().min(2).max(60).optional(),
    points: z.number().int().min(1).max(100).optional(),
    severity: SEVERITY.optional(),
    archived: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Change at least one field");

const RecordBody = z.strictObject({
  learner_ids: z.array(z.guid()).min(1).max(80),
  kind: z.enum(["merit", "demerit", "incident"]),
  category_id: z.guid().nullable().optional(),
  points: z.number().int().min(1).max(100).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  staff_note: z.string().max(1000).nullable().optional(),
  occurred_on: calendarDateString.nullable().optional(),
  subject_id: z.guid().nullable().optional(),
  severity: SEVERITY.nullable().optional(),
});

const VoidBody = z.strictObject({ reason: z.string().min(3).max(300) });

const P = "/v1/tenants/:tenantId/behaviour";

function optionalDay(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isRealCalendarDate(value)) {
    throw validationError(`${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
}

function optionalKind(value: unknown): BehaviourKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "merit" && value !== "demerit" && value !== "incident") throw validationError("kind must be merit, demerit or incident");
  return value;
}

export async function registerBehaviourRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(`${P}/settings`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requireBehaviourReader(tx, auth.authz, ip);
      return { settings: await getBehaviourSettings(tx, params.tenantId) };
    });
  });

  app.put(`${P}/settings`, async (request) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(SettingsBody, request.body, "the behaviour settings are required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requireBehaviourWriter(tx, auth.authz, ip);
      return { settings: await saveBehaviourSettings(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, settings: body }) };
    });
  });

  app.get(`${P}/categories`, async (request) => {
    const params = request.params as { tenantId: string };
    const includeArchived = optionalBool((request.query as Record<string, unknown>).include_archived, "include_archived") === true;
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const access = await requireBehaviourReader(tx, auth.authz, ip);
      // A teacher records with the categories in use; only the office sees the archived ones.
      return { categories: await listBehaviourCategories(tx, { tenantId: params.tenantId, includeArchived: includeArchived && access.office }) };
    });
  });

  app.post(`${P}/categories`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(CategoryBody, request.body, "kind, name and points are required");
    const category = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requireBehaviourWriter(tx, auth.authz, ip);
      return createBehaviourCategory(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body });
    });
    return reply.status(201).send({ category });
  });

  // The 14 suggested categories a school lacks. Registered before the by-id route so "defaults" is never read as an id.
  app.post(`${P}/categories/defaults`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requireBehaviourWriter(tx, auth.authz, ip);
      return { added: await addDefaultBehaviourCategories(tx, { tenantId: params.tenantId, actorUserId: auth.user.id }) };
    });
  });

  app.patch(`${P}/categories/:categoryId`, async (request) => {
    const params = request.params as { tenantId: string; categoryId: string };
    assertUuid(params.categoryId, "categoryId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requireBehaviourWriter(tx, auth.authz, ip);
      // Parsed after the permission check, so an empty body is a 403 for a caller who may not edit, not a 400 (the RBAC sweeps).
      const body = parseOrThrow(CategoryPatchBody, request.body, "Change at least one field");
      return {
        category: await updateBehaviourCategory(tx, {
          tenantId: params.tenantId,
          actorUserId: auth.user.id,
          categoryId: params.categoryId,
          ...body,
        }),
      };
    });
  });

  app.post(`${P}/entries`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(RecordBody, request.body, "learner_ids, kind and a category are required");
    const entryIds = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const access = await requireBehaviourReader(tx, auth.authz, ip);
      // The office records for any learner; a teacher only for the learners they teach.
      if (!access.write && !access.record) await requirePermission(tx, auth.authz, DISCIPLINE_WRITE, { ip, deferAudit: true });
      const scope = await behaviourScope(tx, { tenantId: params.tenantId, userId: auth.user.id, access: { ...access, office: access.write } });
      return recordBehaviour(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        scope,
        learnerIds: body.learner_ids,
        kind: body.kind,
        categoryId: body.category_id ?? null,
        points: body.points ?? null,
        note: body.note ?? null,
        staffNote: body.staff_note ?? null,
        occurredOn: body.occurred_on ?? null,
        subjectId: body.subject_id ?? null,
        severity: body.severity ?? null,
      });
    });
    return reply.status(201).send({ count: entryIds.length, entry_ids: entryIds });
  });

  app.get(`${P}/entries`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    const filters: EntryFilters = {
      classId: optionalUuid(q.class_id, "class_id"),
      kind: optionalKind(q.kind),
      categoryId: optionalUuid(q.category_id, "category_id"),
      recordedBy: optionalUuid(q.recorded_by, "recorded_by"),
      learnerId: optionalUuid(q.learner_id, "learner_id"),
      from: optionalDay(q.from, "from"),
      to: optionalDay(q.to, "to"),
      openOnly: optionalBool(q.open_only, "open_only") === true,
      seriousOnly: optionalBool(q.serious_only, "serious_only") === true,
      includeVoided: optionalBool(q.include_voided, "include_voided") === true,
    };
    if (filters.from && filters.to && filters.to < filters.from) throw validationError("to must not be before from");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const access = await requireBehaviourReader(tx, auth.authz, ip);
      const scope = await behaviourScope(tx, { tenantId: params.tenantId, userId: auth.user.id, access });
      const res = await listBehaviourEntries(tx, { tenantId: params.tenantId, scope, filters, page });
      return { entries: res.items, page: res.page };
    });
  });

  app.post(`${P}/entries/:entryId/void`, async (request) => {
    const params = request.params as { tenantId: string; entryId: string };
    assertUuid(params.entryId, "entryId");
    const body = parseOrThrow(VoidBody, request.body, "Say why it is being voided");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const access = await requireBehaviourReader(tx, auth.authz, ip);
      const scope = await behaviourScope(tx, { tenantId: params.tenantId, userId: auth.user.id, access });
      return {
        entry: await voidBehaviourEntry(tx, {
          tenantId: params.tenantId,
          actorUserId: auth.user.id,
          access,
          scope,
          entryId: params.entryId,
          reason: body.reason,
        }),
      };
    });
  });

  app.get(`${P}/points`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    const classId = optionalUuid(q.class_id, "class_id");
    const on = optionalDay(q.on, "on");
    let learnerIds: string[] | undefined;
    if (typeof q.learner_ids === "string" && q.learner_ids !== "") {
      learnerIds = q.learner_ids.split(",");
      if (learnerIds.length > 100) throw validationError("learner_ids takes at most 100 ids");
      for (const id of learnerIds) assertUuid(id, "learner_ids");
    } else if (q.learner_ids !== undefined && q.learner_ids !== "") {
      throw validationError("learner_ids must be a comma-separated list of UUIDs");
    }
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const access = await requireBehaviourReader(tx, auth.authz, ip);
      const scope = await behaviourScope(tx, { tenantId: params.tenantId, userId: auth.user.id, access });
      const res = await listLearnerPoints(tx, { tenantId: params.tenantId, scope, classId, learnerIds, on, page });
      return { learners: res.items, page: res.page };
    });
  });

  app.get(`${P}/classes`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const access = await requireBehaviourReader(tx, auth.authz, ip);
      const scope = await behaviourScope(tx, { tenantId: params.tenantId, userId: auth.user.id, access });
      return { classes: await listBehaviourClasses(tx, { tenantId: params.tenantId, scope }) };
    });
  });

  app.get(`${P}/recorders`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, DISCIPLINE_READ, { ip, deferAudit: true });
      return { recorders: await listBehaviourRecorders(tx, params.tenantId) };
    });
  });
}
