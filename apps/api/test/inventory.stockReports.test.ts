import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * The stock reports (docs/INVENTORY-STOCK.md, slice S1b, migration 116): ledger, usage, spend by month, cost per meal,
 * headcount and consumption flags, through the real figbloom_app login. Negative first (who may not read them, and the
 * database functions refusing another school), then the numbers on a small school whose answers are worked out by hand.
 * The same functions were also checked row for row against the live Supabase functions on a generated school (PR text).
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, any>;

describe("inventory stock reports", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const spec = loadSpec();
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const P = (tenant: string) => `/v1/tenants/${tenant}/inventory`;
  const REPORTS: Array<[string, string]> = [
    ["ledger", "?from=2026-03-01&to=2026-04-30"],
    ["usage", "?from=2026-03-01&to=2026-04-30"],
    ["spend-by-month", "?from=2026-03-01&to=2026-04-30"],
    ["cost-per-meal", "?from=2026-03-01&to=2026-04-30"],
    ["headcount", "?from=2026-03-02&to=2026-03-05"],
    ["flags", "?from=2026-03-01&to=2026-04-30"],
  ];

  const get = (who: string, path: string, opts: { tenant?: string; header?: string } = {}) => {
    const tenant = opts.tenant ?? ids.tenantA;
    return ctx.app.inject({
      method: "GET",
      url: `${P(tenant)}/reports/${path}`,
      headers: { authorization: `Bearer ${tok[who]}`, "x-tenant-id": opts.header ?? tenant },
    });
  };
  const ok = async (path: string): Promise<Json> => {
    const res = await get("admin", path);
    expect(res.statusCode, `${path} ${res.body}`).toBe(200);
    const schema = responseSchema(spec, "GET", `/v1/tenants/{tenantId}/inventory/reports/${path.split("?")[0]}`, 200);
    expect(typeof schema, String(schema)).toBe("object");
    const errs = validate(spec, schema, res.json());
    expect(errs, errs.join("; ")).toEqual([]);
    return res.json();
  };
  const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);
  const post = async (path: string, payload: Json) => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `${P(ids.tenantA)}${path}`,
      headers: { authorization: `Bearer ${tok.admin}`, "x-tenant-id": ids.tenantA },
      payload,
    });
    expect(res.statusCode, `${path} ${JSON.stringify(payload)} ${res.body}`).toBe(201);
    return res.json();
  };
  const move = (item: string, m: Json) => post("/movements", { item_id: item, ...m });

  async function member(name: string, role: string, loginId: string, tenant: string): Promise<string> {
    const userId = randomUUID();
    await q(
      `INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, NULL, password_hash, $2, 'active' FROM users WHERE id = $3`,
      [userId, name, ids.adminA],
    );
    await q(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [userId, tenant, role, loginId]);
    return userId;
  }
  async function login(tenantId: string, loginId: string): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId, loginId, password: "correct-horse-battery" } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  }
  async function byEmail(email: string): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: "correct-horse-battery" } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  }
  async function asApp<T>(tenant: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      if (tenant) await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenant, ids.adminA]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const A = ids.tenantA;
    const B = ids.tenantB;
    id.storeTeacher = await member("Store Teacher", "teacher", "TC-0002", A);
    id.feesTeacher = await member("Fees Teacher", "teacher", "TC-0003", A);
    id.adminB = await member("Admin B", "school_admin", "AD-0002", B);
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'inventory')`, [A, id.storeTeacher]);
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees')`, [A, id.feesTeacher]);
    tok.admin = await byEmail("admin-a@example.com");
    tok.orgAdmin = await byEmail("orgadmin@example.com");
    tok.adminB = await login(B, "AD-0002");
    tok.storeTeacher = await login(A, "TC-0002");
    tok.feesTeacher = await login(A, "TC-0003");
    tok.teacher = await login(A, "TC-0001");
    tok.parent = await login(A, "PT-0001");

    // School A, worked out by hand below. 2 March 2026 is a Monday; the term runs 5 January to 3 April.
    const item = async (name: string, extra: Json = {}) =>
      (await post("/items", { name, category: "kitchen", tracking: "stock", quantity: 0, consumable: true, unit: "kg", ...extra })).item.id as string;
    id.rice = await item("Rice");
    id.beans = await item("Beans");
    id.sugar = await item("Sugar", { quantity: 5, reorder_level: 10 });
    await move(id.rice, { kind: "received", quantity: 100, unit_cost_cents: 10000, supplier: "Mill A", occurred_on: "2026-03-02" });
    await move(id.beans, { kind: "received", quantity: 40, unit_cost_cents: 20000, supplier: "Mill B", occurred_on: "2026-03-02" });
    await move(id.rice, { kind: "used", quantity: 10, purpose: "Lunch", meals_served: 100, occurred_on: "2026-03-03" });
    await move(id.beans, { kind: "used", quantity: 5, purpose: "Lunch", meals_served: 100, occurred_on: "2026-03-03" });
    await move(id.rice, { kind: "used", quantity: 4, purpose: "Breakfast", occurred_on: "2026-03-03" });
    await move(id.rice, { kind: "received", quantity: 50, unit_cost_cents: 12000, supplier: "Mill A", occurred_on: "2026-03-05" });
    await move(id.rice, { kind: "used", quantity: 20, purpose: "Lunch", meals_served: 200, occurred_on: "2026-03-06" });
    await move(id.rice, { kind: "wasted", quantity: 2, purpose: "Spoilt", occurred_on: "2026-03-06" });
    await move(id.rice, { kind: "adjusted", quantity: -3, occurred_on: "2026-03-07" });
    await move(id.rice, { kind: "adjusted", quantity: 1, occurred_on: "2026-03-07" });
    await move(id.beans, { kind: "used", quantity: 1, purpose: "Lunch", occurred_on: "2026-03-07" }); // a Saturday, no boarders
    await move(id.rice, { kind: "received", quantity: 30, unit_cost_cents: 14000, supplier: "Mill A", occurred_on: "2026-03-12" });
    await move(id.rice, { kind: "used", quantity: 2, purpose: "Lunch", occurred_on: "2026-04-20" }); // after the term

    const year = (await q(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, '2026', '2026-01-01', '2026-12-31') RETURNING id`, [A])).rows[0].id;
    await q(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, 'Term 1', '2026-01-05', '2026-04-03')`, [A, year]);
    // headcount: 3 learners on the roll and one archived on 4 March (Nairobi); 2 staff and one archived on 5 March; 2 visitors
    // on 3 March in Nairobi time, one of them at 01:30 (22:30 UTC on the 2nd)
    for (let n = 1; n <= 3; n++) await q(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Hc Learner', 'female')`, [A, `HC-${n}`]);
    await q(`INSERT INTO learners (tenant_id, admission_no, full_name, gender, active, archived_at) VALUES ($1, 'HC-9', 'Hc Gone', 'male', false, '2026-03-04T07:00:00Z')`, [A]);
    for (let n = 1; n <= 2; n++) await q(`INSERT INTO staff_members (tenant_id, full_name) VALUES ($1, 'Hc Staff')`, [A]);
    await q(`INSERT INTO staff_members (tenant_id, full_name, active, archived_at) VALUES ($1, 'Hc Left', false, '2026-03-05T07:00:00Z')`, [A]);
    // the gate's own trigger stamps arrived_at with now(), so these past visits go in with triggers off (owner, test only)
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        `INSERT INTO gate_visits (tenant_id, visitor_name, purpose, host_kind, arrived_at) VALUES ($1, 'Early', 'Delivery', 'office', '2026-03-02T22:30:00Z'), ($1, 'Later', 'Meeting', 'office', '2026-03-03T09:00:00Z')`,
        [A],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }

    // School B: stock and people that school A's reports must never count
    const bItem = (await q(`INSERT INTO inventory_items (tenant_id, name, category, tracking, quantity, consumable) VALUES ($1, 'B Rice', 'kitchen', 'stock', 0, true) RETURNING id`, [B])).rows[0].id;
    await q(`INSERT INTO inventory_movements (tenant_id, item_id, kind, quantity, unit_cost_cents, occurred_on) VALUES ($1, $2, 'received', 500, 99999, '2026-03-03')`, [B, bItem]);
    await q(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'B-1', 'B Learner', 'male')`, [B]);
  }, 240_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("who may read the reports", () => {
    it("a parent, a teacher without the Inventory area and a holder of another area get the audited 403", async () => {
      for (const who of ["parent", "teacher", "feesTeacher"]) {
        for (const [path, query] of REPORTS) {
          const res = await get(who, path + query);
          expect(res.statusCode, `${who} ${path}`).toBe(403);
        }
      }
      const denied = await q(`SELECT count(*)::int AS n FROM security_audit_events WHERE actor_user_id = $1 AND event_type = 'rbac.permission.denied' AND detail->>'permission' = 'resource.inventory.read'`, [ids.parentA]);
      expect(denied.rows[0].n).toBe(REPORTS.length);
    });

    it("another school by path and by header, an org admin without a delegation, a suspended school and anonymous are refused", async () => {
      for (const [path, query] of REPORTS) {
        expect((await get("adminB", path + query)).statusCode, `adminB ${path}`).toBe(403);
        expect((await get("admin", path + query, { tenant: ids.tenantB })).statusCode, `path ${path}`).toBe(403);
        expect((await get("admin", path + query, { header: ids.tenantB })).statusCode, `header ${path}`).toBe(403);
        expect((await get("orgAdmin", path + query)).statusCode, `orgAdmin ${path}`).toBe(403);
        expect((await ctx.app.inject({ method: "GET", url: `${P(ids.tenantA)}/reports/${path}${query}` })).statusCode, `anonymous ${path}`).toBe(401);
      }
      await q(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [ids.tenantA]);
      try {
        for (const [path, query] of REPORTS) expect((await get("admin", path + query)).statusCode, `suspended ${path}`).toBe(403);
      } finally {
        await q(`UPDATE tenants SET status = 'active' WHERE id = $1`, [ids.tenantA]);
      }
    });

    it("the database functions refuse a school other than the request's, and a request with no school", async () => {
      const calls = [
        "SELECT * FROM public.inventory_ledger($1, '2026-03-01', '2026-03-31')",
        "SELECT * FROM public.inventory_usage($1, '2026-03-01', '2026-03-31', 'week')",
        "SELECT * FROM public.inventory_spend_by_month($1, '2026-03-01', '2026-03-31')",
        "SELECT * FROM public.inventory_cost_per_meal($1, '2026-03-01', '2026-03-31', 'month')",
        "SELECT * FROM public.inventory_stock_levels($1, '2026-03-31')",
        "SELECT * FROM public.inventory_headcount($1, '2026-03-01', '2026-03-31')",
        "SELECT * FROM public.inventory_headcount_days($1, '2026-03-01', '2026-03-31')",
        "SELECT * FROM public.inventory_consumption_flags($1, '2026-03-01', '2026-03-31')",
      ];
      for (const sql of calls) {
        await expect(asApp(ids.tenantA, (c) => c.query(sql, [ids.tenantB])), sql).rejects.toMatchObject({ code: "42501" });
        await expect(asApp(null, (c) => c.query(sql, [ids.tenantA])), sql).rejects.toMatchObject({ code: "42501" });
      }
      // and an item of another school has no price here
      const bItem = (await q(`SELECT id FROM inventory_items WHERE tenant_id = $1`, [ids.tenantB])).rows[0].id;
      expect((await asApp(ids.tenantA, (c) => c.query(`SELECT public.inventory_price_on($1, '2026-03-31') AS p`, [bItem]))).rows[0].p).toBeNull();
    });

    it("a holder of the Inventory area reads every report; an org admin with a delegation of the area too", async () => {
      for (const [path, query] of REPORTS) expect((await get("storeTeacher", path + query)).statusCode, path).toBe(200);
      await q(`INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1, $2, $3, 'area.inventory', $3)`, [ids.orgA, ids.tenantA, ids.orgAdmin]);
      try {
        for (const [path, query] of REPORTS) expect((await get("orgAdmin", path + query)).statusCode, path).toBe(200);
      } finally {
        await q(`DELETE FROM org_admin_school_delegations WHERE delegate_user_id = $1`, [ids.orgAdmin]);
      }
    });
  });

  describe("the numbers", () => {
    it("ledger: every movement of the school in the period, oldest first; nothing of school B", async () => {
      const body = await ok("ledger?from=2026-03-01&to=2026-03-31");
      expect(body.entries.length).toBe(12); // rice 9, beans 3
      expect(body.entries.every((e: Json) => e.source === "movement")).toBe(true);
      expect(body.entries.map((e: Json) => e.occurred_on)).toEqual([...body.entries.map((e: Json) => e.occurred_on)].sort());
      expect(body.entries.find((e: Json) => e.unit_cost_cents === 99999)).toBeUndefined();
      expect((await ok("ledger?from=2026-04-01&to=2026-04-30")).entries.map((e: Json) => [e.kind, e.quantity])).toEqual([["used", 2]]);
    });

    it("usage: per item per week (default) and per day, with shrinkage and the cost of use at the day's price", async () => {
      const week = await ok("usage?from=2026-03-01&to=2026-03-31");
      expect(week.bucket).toBe("week");
      const riceWeek = week.usage.find((u: Json) => u.item_id === id.rice && u.period_start === "2026-03-02");
      // used 10 + 4 + 20, wasted 2, received 100 + 50, stock-take -3 (+1 is not shrinkage); deliveries 100 x 100 + 50 x 120;
      // use priced at the day: 14 x 100 (3 March), 20 x 120 (6 March)
      expect(riceWeek).toEqual({ item_id: id.rice, period_start: "2026-03-02", used: 34, wasted: 2, received: 150, shrinkage: 3, spend_cents: 1_600_000, used_cost_cents: 14 * 10000 + 20 * 12000 });
      const riceNext = week.usage.find((u: Json) => u.item_id === id.rice && u.period_start === "2026-03-09");
      expect(riceNext).toMatchObject({ received: 30, spend_cents: 420_000, used: 0 });
      const day = await ok("usage?from=2026-03-03&to=2026-03-03&bucket=day");
      expect(day.usage.find((u: Json) => u.item_id === id.beans)).toMatchObject({ period_start: "2026-03-03", used: 5, used_cost_cents: 100_000 });
      const month = await ok("usage?from=2026-03-01&to=2026-04-30&bucket=month");
      expect(month.usage.filter((u: Json) => u.item_id === id.rice).map((u: Json) => u.period_start)).toEqual(["2026-03-01", "2026-04-01"]);
      // use in April priced at the latest delivery on or before it (14000)
      expect(month.usage.find((u: Json) => u.item_id === id.rice && u.period_start === "2026-04-01").used_cost_cents).toBe(28_000);
    });

    it("spend by month: deliveries per month and store", async () => {
      const body = await ok("spend-by-month?from=2026-03-01&to=2026-04-30");
      expect(body.spend).toEqual([{ month: "2026-03-01", category: "kitchen", spend_cents: 100 * 10000 + 40 * 20000 + 50 * 12000 + 30 * 14000, deliveries: 4 }]);
    });

    it("cost per meal: meals counted once per day and purpose, only days with meals count towards the cost of a meal", async () => {
      const body = await ok("cost-per-meal?from=2026-03-01&to=2026-03-31");
      expect(body.bucket).toBe("month");
      const lunch = body.cost_per_meal.find((r: Json) => r.purpose === "Lunch");
      // 3 March: rice 10 x 100 + beans 5 x 200 = 2,000 for 100 meals; 6 March: rice 20 x 120 = 2,400 for 200 meals;
      // 7 March: beans 1 x 200 = 200, no meals recorded
      expect(lunch).toEqual({ period_start: "2026-03-01", purpose: "Lunch", used_cost_cents: 200_000 + 240_000 + 20_000, meals_served: 300, cost_per_meal_cents: 1466.67 });
      const breakfast = body.cost_per_meal.find((r: Json) => r.purpose === "Breakfast");
      expect(breakfast).toEqual({ period_start: "2026-03-01", purpose: "Breakfast", used_cost_cents: 40_000, meals_served: 0, cost_per_meal_cents: null });
    });

    it("headcount: learners on the roll, staff and visitors per day, in the school's time zone; nothing of school B", async () => {
      const body = await ok("headcount?from=2026-03-02&to=2026-03-05");
      expect(body.days).toEqual([
        { day: "2026-03-02", learners: 4, staff: 3, visitors: 0 },
        { day: "2026-03-03", learners: 4, staff: 3, visitors: 2 },
        { day: "2026-03-04", learners: 3, staff: 3, visitors: 0 },
        { day: "2026-03-05", learners: 3, staff: 2, visitors: 0 },
      ]);
    });

    it("flags: stock-take shortfall, price jump, use on a weekend and outside every term, and running out", async () => {
      const body = await ok("flags?from=2026-03-01&to=2026-04-30");
      const today = (await q(`SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date::text AS d`)).rows[0].d as string;
      const found = body.flags.map((f: Json) => `${f.kind} ${f.item_name} ${f.occurred_on}`).sort();
      expect(found).toEqual([
        "non_school_day Beans 2026-03-07",
        "non_school_day Rice 2026-04-20",
        "price_jump Rice 2026-03-12",
        `run_out Sugar ${today}`,
        "shrinkage Rice 2026-03-07",
      ]);
      const by = (kind: string, item: string) => body.flags.find((f: Json) => f.kind === kind && f.item_name === item);
      expect(by("shrinkage", "Rice")).toMatchObject({
        severity: "medium", expected: 2, actual: 3, period_from: "2026-02-05", explained: false,
        reason: "Stock-take on Sat 07 Mar found 3 kg of Rice short; normal waste over the month before was about 2 kg.",
      });
      expect(by("price_jump", "Rice")).toMatchObject({
        severity: "medium", expected: 11000, actual: 14000,
        reason: "Rice delivered on Thu 12 Mar by Mill A at 140 a kg, 27% above the usual 110.",
      });
      expect(body.flags.find((f: Json) => f.kind === "non_school_day" && f.item_name === "Beans").reason).toBe(
        "1 kg of Beans recorded as used on Sat 07 Mar, a weekend, and the school has no boarders.",
      );
      expect(body.flags.find((f: Json) => f.kind === "non_school_day" && f.item_name === "Rice").reason).toBe(
        "2 kg of Rice recorded as used on Mon 20 Apr, which is outside every term.",
      );
      expect(by("run_out", "Sugar")).toMatchObject({ severity: "high", reason: "Sugar is at 5 kg, at or below its reorder level of 10 kg." });
    });

    it("flags default to the last 8 weeks to the school's today; to alone means the 8 weeks to it", async () => {
      const today = (await q(`SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date::text AS d`)).rows[0].d as string;
      const def = await ok("flags");
      expect(def.to).toBe(today);
      expect((Date.parse(def.to) - Date.parse(def.from)) / 86_400_000).toBe(55);
      const toOnly = await ok("flags?to=2026-03-31");
      expect(toOnly).toMatchObject({ from: "2026-02-04", to: "2026-03-31" });
    });

    it("refuses a missing or backwards period, an unknown bucket and a period longer than the limits", async () => {
      for (const bad of [
        "ledger", "ledger?from=2026-03-01", "usage?to=2026-03-01", "ledger?from=2026-03-31&to=2026-03-01", "ledger?from=2026-02-31&to=2026-03-01",
        "usage?from=2026-03-01&to=2026-03-31&bucket=fortnight", "cost-per-meal?from=2026-03-01&to=2026-03-31&bucket=hour",
        "ledger?from=2025-01-01&to=2026-03-01", "spend-by-month?from=2025-01-01&to=2026-03-01", "headcount?from=2025-01-01&to=2026-03-01",
        "flags?from=2025-01-01&to=2026-03-01", "flags?from=2026-04-01&to=2026-03-01",
      ]) {
        const res = await get("admin", bad);
        expect(res.statusCode, `${bad} ${res.body}`).toBe(400);
      }
      expect((await get("admin", "usage?from=2025-02-01&to=2026-03-07")).statusCode).toBe(200); // 399 days
      expect((await get("admin", "flags?from=2025-03-01&to=2026-03-01")).statusCode).toBe(200); // 365 days
    });

    it("stock levels read the same database function as the flags", async () => {
      const levels = await ctx.app.inject({ method: "GET", url: `${P(ids.tenantA)}/stock-levels?as_of=2026-03-31`, headers: { authorization: `Bearer ${tok.admin}`, "x-tenant-id": ids.tenantA } });
      expect(levels.statusCode).toBe(200);
      const rice = levels.json().levels.find((l: Json) => l.item_id === id.rice);
      // 100 + 50 + 30 - 10 - 4 - 20 - 2 - 3 + 1 - 2 = 140 now; the 28 days to 31 March start on 4 March: used 20, wasted 2
      expect(rice).toMatchObject({ quantity: 140, unit_cost_cents: 14000, used_28d: 20, wasted_28d: 2, last_received_on: "2026-03-12" });
    });
  });
});
