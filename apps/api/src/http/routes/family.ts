import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPool } from "../../db/pool.js";
import type { Tx } from "../../db/sql.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertMyChild, listMyChildren, type ChildLink } from "../../modules/family/children.js";
import {
  childAttendance,
  childHomework,
  childMaterials,
  childReportCards,
  childResults,
  childTimetable,
} from "../../modules/family/academics.js";
import { childAiHelper, childFees } from "../../modules/family/fees.js";
import { childActivities, childHealth, childItems } from "../../modules/family/life.js";
import { myChatContacts } from "../../modules/family/contacts.js";
import { validationError } from "../errors.js";
import type { RequestAuth } from "../middleware/authContext.js";
import { assertUuid, inTenant, optionalUuid } from "../routeKit.js";
import { isRealCalendarDate } from "../schemas.js";

/**
 * Family reads (A1, docs/FAMILY-READS.md): a parent reads the records of their own linked children. Every route needs
 * `resource.family.read` (an audited 403 for staff), and every per-child route then proves the learner is the caller's
 * child in this school (404 for every other case, audited).
 */
const FAMILY_READ = "resource.family.read" as const;
const P = "/v1/tenants/:tenantId/me";
const C = `${P}/children/:learnerId`;

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isRealCalendarDate(value)) {
    throw validationError(`${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
}

export async function inChild<T>(
  app: FastifyInstance,
  pool: AppPool,
  request: FastifyRequest,
  fn: (ctx: { tx: Tx; auth: RequestAuth; ip: string | null; tenantId: string; learnerId: string; link: ChildLink }) => Promise<T>,
): Promise<T> {
  const params = request.params as { tenantId: string; learnerId: string };
  assertUuid(params.learnerId, "learnerId");
  return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
    await requirePermission(tx, auth.authz, FAMILY_READ, { ip, deferAudit: true });
    const link = await assertMyChild(tx, { learnerId: params.learnerId, actorUserId: auth.user.id, tenantId: params.tenantId, ip });
    return fn({ tx, auth, ip, tenantId: params.tenantId, learnerId: params.learnerId, link });
  });
}

export async function registerFamilyRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(`${P}/children`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, FAMILY_READ, { ip, deferAudit: true });
      return { children: await listMyChildren(tx, params.tenantId) };
    });
  });

  app.get(`${C}/attendance`, async (request) => {
    const q = request.query as Record<string, unknown>;
    const from = optionalDate(q.from, "from");
    const to = optionalDate(q.to, "to");
    return inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      attendance: await childAttendance(tx, { tenantId, learnerId, from, to }),
    }));
  });

  app.get(`${C}/results`, async (request) => {
    const termId = optionalUuid((request.query as Record<string, unknown>).termId, "termId");
    return inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => childResults(tx, { tenantId, learnerId, termId }));
  });

  app.get(`${C}/report-cards`, async (request) =>
    inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      report_cards: await childReportCards(tx, { tenantId, learnerId }),
    })),
  );

  app.get(`${C}/homework`, async (request) => {
    const from = optionalDate((request.query as Record<string, unknown>).from, "from");
    return inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => childHomework(tx, { tenantId, learnerId, from }));
  });

  app.get(`${C}/materials`, async (request) =>
    inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      materials: await childMaterials(tx, { tenantId, learnerId }),
    })),
  );

  app.get(`${C}/timetable`, async (request) =>
    inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      timetable: await childTimetable(tx, { tenantId, learnerId }),
    })),
  );

  app.get(`${C}/fees`, async (request) =>
    inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      invoices: await childFees(tx, { tenantId, learnerId }),
    })),
  );

  app.get(`${C}/activities`, async (request) =>
    inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      activities: await childActivities(tx, { tenantId, learnerId }),
    })),
  );

  app.get(`${C}/items`, async (request) =>
    inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      items: await childItems(tx, { tenantId, learnerId }),
    })),
  );

  app.get(`${C}/health`, async (request) =>
    inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      health: await childHealth(tx, { tenantId, learnerId }),
    })),
  );

  app.get(`${C}/ai-helper`, async (request) =>
    inChild(app, pool, request, async ({ tx, tenantId, learnerId }) => ({
      ai_helper: await childAiHelper(tx, { tenantId, learnerId }),
    })),
  );

  app.get(`${P}/chat-contacts`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, FAMILY_READ, { ip, deferAudit: true });
      return { contacts: await myChatContacts(tx, params.tenantId) };
    });
  });
}
