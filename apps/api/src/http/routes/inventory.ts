import type { FastifyInstance } from "fastify";
import { calendarDateString } from "../schemas.js";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  closeInventoryIssue,
  createInventoryItem,
  getInventoryItem,
  issueInventoryItem,
  listInventoryItems,
  listOpenIssues,
  retireInventoryItem,
} from "../../modules/inventory/inventory.js";
import { notFound } from "../errors.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const ItemBody = z.strictObject({
  name: z.string().min(1).max(160),
  category: z.enum([
    "textbooks",
    "furniture",
    "lab_equipment",
    "sports",
    "ict",
    "uniforms",
    "music",
    "kitchen",
    "stationery",
    "tools",
    "medical",
    "other",
  ]),
  tracking: z.enum(["asset", "stock"]),
  quantity: z.number().int().positive().optional(),
  asset_tag: z.string().min(1).max(80).nullable().optional(),
  condition: z.enum(["new", "good", "fair", "poor", "broken"]).optional(),
  location: z.string().max(120).nullable().optional(),
});

const IssueBody = z.strictObject({
  item_id: z.guid(),
  learner_id: z.guid().nullable().optional(),
  holder_user_id: z.guid().nullable().optional(),
  quantity: z.number().int().positive().optional(),
  due_on: calendarDateString.nullable().optional(),
});

const CloseBody = z.strictObject({
  status: z.enum(["returned", "damaged", "lost"]),
  returned_condition: z.enum(["new", "good", "fair", "poor", "broken"]).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

const P = "/v1/tenants/:tenantId/inventory";

export async function registerInventoryRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(`${P}/items`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(ItemBody, request.body, "name, category and tracking are required");
    const item = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.write", { ip, deferAudit: true });
      return createInventoryItem(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body });
    });
    return reply.status(201).send({ item });
  });

  app.get(`${P}/items`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.read", { ip, deferAudit: true });
      return listInventoryItems(tx, { tenantId: params.tenantId, limit: page.limit, rawCursor: page.rawCursor });
    });
  });

  app.get(`${P}/items/:itemId`, async (request) => {
    const params = request.params as { tenantId: string; itemId: string };
    assertUuid(params.itemId, "itemId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.read", { ip, deferAudit: true });
      const item = await getInventoryItem(tx, params.tenantId, params.itemId);
      if (!item) throw notFound("Inventory item not found");
      return { item };
    });
  });

  app.post(`${P}/items/:itemId/retire`, async (request) => {
    const params = request.params as { tenantId: string; itemId: string };
    assertUuid(params.itemId, "itemId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.write", { ip, deferAudit: true });
      return {
        item: await retireInventoryItem(tx, {
          tenantId: params.tenantId,
          itemId: params.itemId,
          actorUserId: auth.user.id,
        }),
      };
    });
  });

  app.post(`${P}/issues`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(IssueBody, request.body, "item_id and a holder are required");
    const issue = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.write", { ip, deferAudit: true });
      return issueInventoryItem(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        itemId: body.item_id,
        learnerId: body.learner_id,
        holderUserId: body.holder_user_id,
        quantity: body.quantity,
        dueOn: body.due_on,
      });
    });
    return reply.status(201).send({ issue });
  });

  app.get(`${P}/issues`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.read", { ip, deferAudit: true });
      return listOpenIssues(tx, params.tenantId, page.limit, page.rawCursor);
    });
  });

  app.post(`${P}/issues/:issueId/close`, async (request) => {
    const params = request.params as { tenantId: string; issueId: string };
    assertUuid(params.issueId, "issueId");
    const body = parseOrThrow(CloseBody, request.body, "status is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.write", { ip, deferAudit: true });
      return {
        issue: await closeInventoryIssue(tx, {
          tenantId: params.tenantId,
          issueId: params.issueId,
          actorUserId: auth.user.id,
          status: body.status,
          returnedCondition: body.returned_condition,
          note: body.note,
        }),
      };
    });
  });
}
