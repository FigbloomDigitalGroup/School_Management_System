import type { FastifyInstance } from "fastify";
import { calendarDateString } from "../schemas.js";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import type { Tx } from "../../db/sql.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  assertValidCalendarDate,
  closeInventoryIssue,
  createInventoryItem,
  getInventoryItem,
  issueInventoryItem,
  listInventoryItems,
  listMyOpenIssues,
  listOpenIssues,
  retireInventoryItem,
} from "../../modules/inventory/inventory.js";
import { listStockMovements, MOVEMENT_KINDS, recordStockMovement, stockLevels } from "../../modules/inventory/stock.js";
import {
  REPORT_BUCKETS,
  stockCostPerMeal,
  stockFlags,
  stockHeadcount,
  stockLedger,
  stockSpendByMonth,
  stockUsage,
  type ReportBucket,
} from "../../modules/inventory/stockReports.js";
import { notFound, validationError } from "../errors.js";
import { assertUuid, inTenant, optionalUuid, pageFrom } from "../routeKit.js";
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
  // a stock line may start at 0 (a consumable before its first delivery); an asset is always 1
  quantity: z.number().int().min(0).max(2147483647).optional(),
  asset_tag: z.string().min(1).max(80).nullable().optional(),
  condition: z.enum(["new", "good", "fair", "poor", "broken"]).optional(),
  location: z.string().max(120).nullable().optional(),
  // migration 115 (docs/INVENTORY-STOCK.md): stock lines only
  unit: z.string().min(1).max(20).nullable().optional(),
  consumable: z.boolean().optional(),
  reorder_level: z.number().int().min(0).max(2147483647).nullable().optional(),
});

/** One delivery, a day's use, waste, or a stock-take correction (docs/INVENTORY-STOCK.md). The sign rules are in the module. */
const MovementBody = z.strictObject({
  item_id: z.guid(),
  kind: z.enum(MOVEMENT_KINDS),
  quantity: z.number().int().min(-2147483648).max(2147483647),
  occurred_on: calendarDateString.optional(),
  unit_cost_cents: z.number().int().min(0).nullable().optional(),
  supplier: z.string().max(160).nullable().optional(),
  reference: z.string().max(80).nullable().optional(),
  purpose: z.string().max(120).nullable().optional(),
  meals_served: z.number().int().min(0).max(2147483647).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

/** An optional YYYY-MM-DD query value: absent or empty is no filter. */
function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw validationError(`${field} must be YYYY-MM-DD`);
  assertValidCalendarDate(value, field);
  return value;
}

/** A required YYYY-MM-DD query value. */
function requiredDate(value: unknown, field: string): string {
  const day = optionalDate(value, field);
  if (!day) throw validationError(`${field} is required (YYYY-MM-DD)`);
  return day;
}

/** The report bucket: day, week (from Monday), month or year; `fallback` when absent. */
function bucketFrom(value: unknown, fallback: ReportBucket): ReportBucket {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (REPORT_BUCKETS as readonly string[]).includes(value)) return value as ReportBucket;
  throw validationError("bucket must be day, week, month or year");
}

const IssueBody = z.strictObject({
  item_id: z.guid(),
  learner_id: z.guid().nullable().optional(),
  holder_user_id: z.guid().nullable().optional(),
  quantity: z.number().int().positive().optional(),
  due_on: calendarDateString.nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

function issueStatusFilter(value: unknown): "all" | "out" | "returned" | "damaged" | "lost" {
  if (value === undefined || value === null || value === "") return "out";
  if (typeof value === "string" && ["all", "out", "returned", "damaged", "lost"].includes(value)) {
    return value as "all" | "out" | "returned" | "damaged" | "lost";
  }
  throw validationError("status must be all, out, returned, damaged or lost");
}

const CloseBody = z.strictObject({
  status: z.enum(["returned", "damaged", "lost"]),
  returned_condition: z.enum(["new", "good", "fair", "poor", "broken"]).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

export const INVENTORY_STOCK_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/inventory/issues": IssueBody,
  "POST /v1/tenants/{tenantId}/inventory/movements": MovementBody,
} as const;

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
        note: body.note,
      });
    });
    return reply.status(201).send({ issue });
  });

  app.get(`${P}/issues`, async (request) => {
    const params = request.params as { tenantId: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.read", { ip, deferAudit: true });
      return listOpenIssues(tx, params.tenantId, page.limit, page.rawCursor, issueStatusFilter(query.status));
    });
  });

  // The caller's own open issues (docs/TEACHER-READS.md, "My items"). Any active member of the school may read their own:
  // the rows are filtered to `holder_user_id = the caller`, so no inventory permission is needed or checked.
  app.get("/v1/tenants/:tenantId/me/inventory/issues", async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) =>
      listMyOpenIssues(tx, { tenantId: params.tenantId, userId: auth.user.id, page }),
    );
  });

  // Stock in and out (docs/INVENTORY-STOCK.md). Same permissions as the rest of the register.
  app.post(`${P}/movements`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(MovementBody, request.body, "item_id, kind and quantity are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.write", { ip, deferAudit: true });
      return recordStockMovement(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        itemId: body.item_id,
        kind: body.kind,
        quantity: body.quantity,
        occurredOn: body.occurred_on,
        unitCostCents: body.unit_cost_cents,
        supplier: body.supplier,
        reference: body.reference,
        purpose: body.purpose,
        mealsServed: body.meals_served,
        note: body.note,
      });
    });
    return reply.status(201).send(out);
  });

  app.get(`${P}/movements`, async (request) => {
    const params = request.params as { tenantId: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const page = pageFrom(request);
    const itemId = optionalUuid(query.item_id, "item_id");
    const from = optionalDate(query.from, "from");
    const to = optionalDate(query.to, "to");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.read", { ip, deferAudit: true });
      return listStockMovements(tx, { tenantId: params.tenantId, itemId, from, to, page });
    });
  });

  app.get(`${P}/stock-levels`, async (request) => {
    const params = request.params as { tenantId: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const asOf = optionalDate(query.as_of, "as_of");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.inventory.read", { ip, deferAudit: true });
      return stockLevels(tx, { tenantId: params.tenantId, asOf });
    });
  });

  // The stock reports (docs/INVENTORY-STOCK.md, slice S1b): read-only, same permission as the register.
  const report = <T>(path: string, run: (args: { tenantId: string; query: Record<string, unknown> }) => (tx: Tx) => Promise<T>) =>
    app.get(`${P}/reports/${path}`, async (request) => {
      const params = request.params as { tenantId: string };
      const query = (request.query ?? {}) as Record<string, unknown>;
      return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
        await requirePermission(tx, auth.authz, "resource.inventory.read", { ip, deferAudit: true });
        // the query is validated after authorisation, as the other reports do: a refused caller learns nothing from a 400
        return run({ tenantId: params.tenantId, query })(tx);
      });
    });

  report("ledger", ({ tenantId, query }) => {
    const from = requiredDate(query.from, "from");
    const to = requiredDate(query.to, "to");
    return async (tx) => ({ from, to, entries: await stockLedger(tx, { tenantId, from, to }) });
  });
  report("usage", ({ tenantId, query }) => {
    const from = requiredDate(query.from, "from");
    const to = requiredDate(query.to, "to");
    const bucket = bucketFrom(query.bucket, "week");
    return async (tx) => ({ from, to, bucket, usage: await stockUsage(tx, { tenantId, from, to, bucket }) });
  });
  report("spend-by-month", ({ tenantId, query }) => {
    const from = requiredDate(query.from, "from");
    const to = requiredDate(query.to, "to");
    return async (tx) => ({ from, to, spend: await stockSpendByMonth(tx, { tenantId, from, to }) });
  });
  report("cost-per-meal", ({ tenantId, query }) => {
    const from = requiredDate(query.from, "from");
    const to = requiredDate(query.to, "to");
    const bucket = bucketFrom(query.bucket, "month");
    return async (tx) => ({ from, to, bucket, cost_per_meal: await stockCostPerMeal(tx, { tenantId, from, to, bucket }) });
  });
  report("headcount", ({ tenantId, query }) => {
    const from = requiredDate(query.from, "from");
    const to = requiredDate(query.to, "to");
    return async (tx) => ({ from, to, days: await stockHeadcount(tx, { tenantId, from, to }) });
  });
  report("flags", ({ tenantId, query }) => {
    const from = optionalDate(query.from, "from");
    const to = optionalDate(query.to, "to");
    return async (tx) => stockFlags(tx, { tenantId, from, to });
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
