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

/**
 * Platform-owned school subscriptions and Figbloom's plan price list (D3, migration 122).
 * The owner-only tables are never queried directly by figbloom_app; every read/write goes through a SECURITY DEFINER
 * function that independently re-checks super_admin from app.user_id. The session's school and X-Tenant-Id are ignored.
 */

const PLANS = ["standard", "institution", "county"] as const;
const STATUSES = ["active", "trial", "onboarding", "overdue", "suspended", "setup_stalled"] as const;
const SORT = "school_name";

interface SubscriptionRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  plan: string;
  status: string;
  price_cents_override: number | null;
  trial_ends_at_text: string | null;
  renews_on_text: string | null;
  price_cents: number;
}

interface PlanPriceRow { plan: string; price_cents: number; updated_at_text: string }

async function requireBillingActor(db: IdentityDb, request: FastifyRequest, permission: string) {
  const { user, session } = await requireSessionAuth(db, request);
  const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
  await requirePermission(db, authz, permission, { ip: clientIp(request) });
  return { userId: user.id, sessionId: session.id };
}

function dateOnly() {
  return z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
}

const SubscriptionBody = z.strictObject({
  plan: z.enum(PLANS),
  status: z.enum(STATUSES),
  price_cents_override: z.number().int().min(0).nullable(),
  trial_ends_at: z.string().datetime({ offset: true }).nullable(),
  renews_on: dateOnly().nullable(),
});

const PlanPriceBody = z.strictObject({
  price_cents: z.number().int().min(0),
});

export async function registerPlatformBillingRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const opts = () => ({ acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs });

  app.get("/v1/platform/subscriptions", async (request) => {
    const actor = await withIdentityAccess(pool, (db) => requireBillingActor(db, request, "platform.billing.read"), opts());
    const query = request.query as Record<string, unknown>;
    const { limit, cursor, fingerprint } = parseListQuery(query, {
      sort: SORT,
      filter: { scope: "platform_billing_subscriptions" },
      keySpecs: [{ kind: "uuid" }],
    });

    const data = await withIdentityUserScope(pool, actor.userId, async (db) => {
      if (cursor) {
        const anchor = await db.query(`SELECT 1 FROM public.tenants WHERE id = $1::uuid`, [cursor.k[0]]);
        if (anchor.rowCount !== 1) throw validationError("cursor is no longer valid; start again from the first page");
      }
      const rows = await db.query<SubscriptionRow>(
        `SELECT * FROM public.platform_billing_subscriptions_list($1::uuid, $2::integer)`,
        [cursor ? cursor.k[0]! : null, limit + 1],
      );
      const prices = await db.query<PlanPriceRow>(`SELECT * FROM public.platform_billing_plan_prices()`);
      return { rows: rows.rows, prices: prices.rows };
    }, opts());

    const paged = pageFromKeysetRows(data.rows, {
      limit,
      sort: SORT,
      fingerprint,
      keysOf: (row) => [row.tenant_id],
    });

    return {
      items: paged.items.map((row) => ({
        tenantId: row.tenant_id,
        name: row.tenant_name,
        slug: row.tenant_slug,
        plan: row.plan,
        status: row.status,
        priceCentsOverride: row.price_cents_override,
        trialEndsAt: row.trial_ends_at_text,
        renewsOn: row.renews_on_text,
        priceCents: row.price_cents,
      })),
      pricing: data.prices.map((row) => ({ plan: row.plan, priceCents: row.price_cents, updatedAt: row.updated_at_text })),
      page: paged.page,
    };
  });

  app.put("/v1/platform/subscriptions/:schoolId", async (request) => {
    const actor = await withIdentityAccess(pool, (db) => requireBillingActor(db, request, "platform.billing.manage"), opts());
    const { schoolId } = request.params as { schoolId: string };
    if (!uuidString.safeParse(schoolId).success) throw validationError("schoolId must be a UUID");
    const body = parseOrThrow(SubscriptionBody, request.body, "plan, status, price_cents_override, trial_ends_at and renews_on are required");

    const changed = await withIdentityUserScope(pool, actor.userId, async (db) => {
      await assertRecentAuth(db, app.appConfig, actor.sessionId);
      try {
        const result = await db.query<{ changed: boolean }>(
          `SELECT public.platform_billing_subscription_update($1::uuid, $2::text, $3::text, $4::integer, $5::timestamptz, $6::date) AS changed`,
          [schoolId.toLowerCase(), body.plan, body.status, body.price_cents_override, body.trial_ends_at, body.renews_on],
        );
        return result.rows[0]?.changed === true;
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "P0002") throw notFound("Subscription not found");
        throw err;
      }
    }, opts());
    return { changed };
  });

  app.put("/v1/platform/plan-pricing/:plan", async (request) => {
    const actor = await withIdentityAccess(pool, (db) => requireBillingActor(db, request, "platform.billing.manage"), opts());
    const { plan } = request.params as { plan: string };
    if (!(PLANS as readonly string[]).includes(plan)) {
      throw validationError("plan must be standard, institution or county", [
        { field: "plan", code: "invalid_value", message: "Invalid value" },
      ]);
    }
    const body = parseOrThrow(PlanPriceBody, request.body, "price_cents is required");

    const changed = await withIdentityUserScope(pool, actor.userId, async (db) => {
      await assertRecentAuth(db, app.appConfig, actor.sessionId);
      const result = await db.query<{ changed: boolean }>(
        `SELECT public.platform_billing_plan_price_set($1::text, $2::integer) AS changed`,
        [plan, body.price_cents],
      );
      return result.rows[0]?.changed === true;
    }, opts());
    return { changed };
  });
}
