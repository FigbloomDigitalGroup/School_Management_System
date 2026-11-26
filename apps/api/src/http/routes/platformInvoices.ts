import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import type { IdentityDb } from "../../db/sql.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { clientIp } from "../clientIp.js";
import { notFound, validationError } from "../errors.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { uuidString } from "../schemas.js";
import { parseOrThrow } from "../validation.js";

/** Figbloom's invoices for schools (D3, migration 123), separate from a school's parent fee invoices. */

const SORT = "due_date";

interface InvoiceRow {
  invoice_id: string;
  tenant_id: string;
  tenant_name: string;
  amount_cents: number;
  due_date_text: string;
  status: "due" | "paid";
  paid_at_text: string | null;
  created_at_text: string;
}

async function requireBillingActor(db: IdentityDb, request: FastifyRequest, permission: string) {
  const { user, session } = await requireSessionAuth(db, request);
  const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
  await requirePermission(db, authz, permission, { ip: clientIp(request) });
  return { userId: user.id, sessionId: session.id };
}

function dateOnly() {
  return z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    if (Number(value.slice(0, 4)) < 1) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
}

const CreateInvoiceBody = z.strictObject({
  tenantId: uuidString,
  amountCents: z.number().int().min(1).max(2_147_483_647),
  dueDate: dateOnly(),
});

export async function registerPlatformInvoiceRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const opts = () => ({ acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs });

  app.get("/v1/platform/invoices", async (request) => {
    const actor = await withIdentityAccess(pool, (db) => requireBillingActor(db, request, "platform.billing.read"), opts());
    const query = request.query as Record<string, unknown>;
    const { limit, cursor, fingerprint } = parseListQuery(query, {
      sort: SORT,
      filter: { scope: "platform_billing_invoices" },
      keySpecs: [{ kind: "text", maxLen: 10 }, { kind: "uuid" }],
    });
    const beforeDue = cursor?.k[0] ?? null;
    if (beforeDue !== null && !dateOnly().safeParse(beforeDue).success) {
      throw validationError("cursor is invalid; start again from the first page");
    }

    const rows = await withIdentityUserScope(pool, actor.userId, async (db) => {
      const result = await db.query<InvoiceRow>(
        `SELECT * FROM public.platform_billing_invoices_list($1::date, $2::uuid, $3::integer)`,
        [beforeDue, cursor?.k[1] ?? null, limit + 1],
      );
      return result.rows;
    }, opts());

    const paged = pageFromKeysetRows(rows, {
      limit,
      sort: SORT,
      fingerprint,
      keysOf: (row) => [row.due_date_text, row.invoice_id],
    });

    return {
      items: paged.items.map((row) => ({
        invoiceId: row.invoice_id,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        amountCents: row.amount_cents,
        dueDate: row.due_date_text,
        status: row.status,
        paidAt: row.paid_at_text,
        createdAt: row.created_at_text,
      })),
      page: paged.page,
    };
  });

  app.post("/v1/platform/invoices", async (request, reply) => {
    const actor = await withIdentityAccess(pool, (db) => requireBillingActor(db, request, "platform.billing.manage"), opts());
    const body = parseOrThrow(CreateInvoiceBody, request.body, "tenantId, amountCents and dueDate are required");
    const invoiceId = await withIdentityUserScope(pool, actor.userId, async (db) => {
      await assertRecentAuth(db, app.appConfig, actor.sessionId);
      try {
        const result = await db.query<{ invoice_id: string }>(
          `SELECT public.platform_billing_invoice_create($1::uuid, $2::integer, $3::date) AS invoice_id`,
          [body.tenantId.toLowerCase(), body.amountCents, body.dueDate],
        );
        return result.rows[0]?.invoice_id;
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "P0002") throw notFound("School not found");
        throw err;
      }
    }, opts());
    return reply.code(201).send({ invoiceId });
  });

  app.put("/v1/platform/invoices/:invoiceId/mark-paid", async (request) => {
    const actor = await withIdentityAccess(pool, (db) => requireBillingActor(db, request, "platform.billing.manage"), opts());
    const { invoiceId } = request.params as { invoiceId: string };
    if (!uuidString.safeParse(invoiceId).success) throw validationError("invoiceId must be a UUID");

    const changed = await withIdentityUserScope(pool, actor.userId, async (db) => {
      await assertRecentAuth(db, app.appConfig, actor.sessionId);
      try {
        const result = await db.query<{ changed: boolean }>(
          `SELECT public.platform_billing_invoice_mark_paid($1::uuid) AS changed`,
          [invoiceId.toLowerCase()],
        );
        return result.rows[0]?.changed === true;
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "P0002") throw notFound("Invoice not found");
        throw err;
      }
    }, opts());
    return { changed };
  });
}
