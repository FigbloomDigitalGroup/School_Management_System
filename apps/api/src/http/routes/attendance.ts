import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import {
  assertCanTakeRegister,
  getAttendanceSettings,
  getEarlySignOut,
  getRegisterById,
  listCounted,
  listEarlySignOuts,
  listRegisters,
  recordEarlySignOut,
  resolveSession,
  upsertAfternoonRegister,
  upsertAttendanceSettings,
  upsertMorningRegister,
  voidEarlySignOut,
  type AttendanceSession,
  type RegisterOutcome,
} from "../../modules/academics/attendance.js";
import { teacherClassIds } from "../../modules/academics/structure.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import { validationError } from "../errors.js";
import { assertUuid, classReadScope, inTenant, optionalUuid, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SettingsBody = z.strictObject({
  afternoon_enabled: z.boolean(),
  percentage_mode: z.enum(["session", "day"]),
});
const RegisterBody = z.strictObject({
  learner_id: z.guid(),
  class_id: z.guid(),
  term_id: z.guid(),
  taken_on: DateString,
  mark: z.enum(["present", "absent", "late", "excused"]),
  note: z.string().max(500).nullable().optional(),
  marked_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
    .nullable()
    .optional(),
  session: z.enum(["morning", "afternoon"]).nullable().optional(),
});
const SignOutBody = z.strictObject({
  learner_id: z.guid(),
  reason: z.string().min(1).max(200),
  collected_by_name: z.string().min(1).max(120),
  collected_by_relationship: z.string().min(1).max(60),
  id_number: z.string().min(3).max(30),
  phone: z.string().min(6).max(21),
  authorised_by: z.string().min(1).max(120),
  note: z.string().max(500).nullable().optional(),
  signed_out_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
});
const VoidBody = z.strictObject({ reason: z.string().min(1).max(200) });

/** Request bodies by OpenAPI operation key; test/openapi.stage910.contract.test.ts compares them with the spec. */
export const ATTENDANCE_REQUEST_SCHEMAS = {
  "PUT /v1/tenants/{tenantId}/attendance-settings": SettingsBody,
  "POST /v1/tenants/{tenantId}/attendance-registers": RegisterBody,
  "POST /v1/tenants/{tenantId}/early-sign-outs": SignOutBody,
  "POST /v1/tenants/{tenantId}/early-sign-outs/{signOutId}/void": VoidBody,
} as const;

export async function registerAttendanceRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/tenants/:tenantId/attendance-settings", async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.attendance.read", { ip, deferAudit: true });
      return { settings: await getAttendanceSettings(tx, { tenantId: params.tenantId }) };
    });
  });

  app.put("/v1/tenants/:tenantId/attendance-settings", async (request) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(SettingsBody, request.body, "afternoon_enabled and percentage_mode are required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.attendance.write", { ip, deferAudit: true });
      return { settings: await upsertAttendanceSettings(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip }) };
    });
  });

  app.post("/v1/tenants/:tenantId/attendance-registers", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(RegisterBody, request.body, "learner_id, class_id, term_id, taken_on and mark are required");
    const session = resolveSession(parsed.session);
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await assertCanTakeRegister(tx, auth.authz, parsed.class_id, ip);
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/attendance-registers",
        fingerprintInput: { params, body: parsed },
        status: 200,
        execute: async () => {
          const done =
            session === "morning"
              ? await upsertMorningRegister(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip })
              : await upsertAfternoonRegister(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...parsed, ip });
          // R10-5: the outcome travels with the stored reference, so a replay reports what the original did.
          return {
            value: { register: done.register, outcome: done.outcome },
            resourceType: `attendance_${session}:${done.outcome}`,
            resourceId: done.register.id,
          };
        },
        // A9-6: direct lookup by id. Registers keep no history (newest wins), so this is the current row.
        replay: async (refType, id) => {
          const [type, outcome] = refType.split(":");
          const replaySession: AttendanceSession = type === "attendance_afternoon" ? "afternoon" : "morning";
          const register = await getRegisterById(tx, { tenantId: params.tenantId, session: replaySession, registerId: id });
          return register ? { register, outcome: (outcome ?? "applied") as RegisterOutcome } : null;
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/attendance-registers", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const sessionRaw = query.session;
    const session =
      sessionRaw === undefined || sessionRaw === null || sessionRaw === ""
        ? undefined
        : resolveSession(String(sessionRaw));
    const takenOn = query.takenOn === undefined || query.takenOn === "" ? undefined : String(query.takenOn);
    if (takenOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(takenOn)) throw validationError("takenOn must be YYYY-MM-DD");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      // OD-2: attendance readers see every class; a teacher sees only the classes they teach.
      const scope = await classReadScope(tx, auth, ip, "resource.attendance.read");
      const out = await listRegisters(tx, {
        tenantId: params.tenantId,
        classId: optionalUuid(query.classId, "classId"),
        takenOn,
        session,
        scopeClassIds: scope,
        page,
      });
      return { registers: out.items, page: out.page };
    });
  });

  app.get("/v1/tenants/:tenantId/attendance-counted", async (request) => {
    const params = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    // OD-4: one term per request (no unbounded all-time scan), optional class, cursor paging.
    const termId = optionalUuid(query.termId, "termId");
    if (!termId) throw validationError("termId is required");
    const classId = optionalUuid(query.classId, "classId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.attendance.read", { ip, deferAudit: true });
      const out = await listCounted(tx, { tenantId: params.tenantId, termId, classId, page });
      return { entries: out.items, page: out.page };
    });
  });

  app.post("/v1/tenants/:tenantId/early-sign-outs", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const parsed = parseOrThrow(SignOutBody, request.body, "learner and collector fields are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/early-sign-outs",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const recorded = await recordEarlySignOut(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            authz: auth.authz,
            ...parsed,
            ip,
          });
          return { value: recorded, resourceType: "early_sign_out", resourceId: recorded.sign_out.id };
        },
        replay: async (_t, id) =>
          getEarlySignOut(tx, {
            tenantId: params.tenantId,
            signOutId: id,
            includeCollector: await hasPermission(tx, auth.authz, "resource.early_sign_out.collector.read"),
          }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/early-sign-outs", async (request) => {
    const params = request.params as { tenantId: string };
    const takenOnRaw = (request.query as { takenOn?: unknown }).takenOn;
    const takenOn = takenOnRaw === undefined || takenOnRaw === "" ? undefined : String(takenOnRaw);
    if (takenOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(takenOn)) throw validationError("takenOn must be YYYY-MM-DD");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      // OD-2: holders of resource.early_sign_out.read see every sign-out; a teacher sees a sanitised list
      // (collector always null) for learners of the classes they teach; anyone else gets 403.
      let scope: string[] | null = null;
      if (!(await hasPermission(tx, auth.authz, "resource.early_sign_out.read"))) {
        scope = auth.authz.tenantId ? await teacherClassIds(tx, { tenantId: auth.authz.tenantId, userId: auth.user.id }) : [];
        if (scope.length === 0) await requirePermission(tx, auth.authz, "resource.early_sign_out.read", { ip, deferAudit: true });
      }
      const includeCollector = scope === null && (await hasPermission(tx, auth.authz, "resource.early_sign_out.collector.read"));
      const out = await listEarlySignOuts(tx, { tenantId: params.tenantId, takenOn, includeCollector, scopeClassIds: scope, page });
      return { sign_outs: out.items, page: out.page };
    });
  });

  app.get("/v1/tenants/:tenantId/early-sign-outs/:signOutId", async (request) => {
    const params = request.params as { tenantId: string; signOutId: string };
    assertUuid(params.signOutId, "signOutId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.early_sign_out.read", { ip, deferAudit: true });
      const includeCollector = await hasPermission(tx, auth.authz, "resource.early_sign_out.collector.read");
      return getEarlySignOut(tx, { tenantId: params.tenantId, signOutId: params.signOutId, includeCollector });
    });
  });

  app.post("/v1/tenants/:tenantId/early-sign-outs/:signOutId/void", async (request, reply) => {
    const params = request.params as { tenantId: string; signOutId: string };
    assertUuid(params.signOutId, "signOutId");
    const parsed = parseOrThrow(VoidBody, request.body, "reason is required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/early-sign-outs/:signOutId/void",
        fingerprintInput: { params, body: parsed },
        status: 200,
        execute: async () => {
          const voided = await voidEarlySignOut(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            authz: auth.authz,
            signOutId: params.signOutId,
            reason: parsed.reason,
            ip,
          });
          return { value: voided, resourceType: "early_sign_out", resourceId: params.signOutId };
        },
        replay: async () =>
          getEarlySignOut(tx, {
            tenantId: params.tenantId,
            signOutId: params.signOutId,
            includeCollector: await hasPermission(tx, auth.authz, "resource.early_sign_out.collector.read"),
          }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });
}
