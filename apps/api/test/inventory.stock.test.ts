import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Stock in and out (docs/INVENTORY-STOCK.md, migration 115), through the real figbloom_app login. A port of the live Supabase
 * feature (20261124200000_inventory_movements.sql). Negative first: who may not record or read stock (a parent, a teacher
 * without the Inventory area, a holder of another area, another school by path and by header, an org admin without a
 * delegation, a suspended school, anonymous), what the database refuses on its own (another school's rows, rewriting or
 * removing a movement, a forged recorder, two people taking the last stock at once); then the rules and the numbers.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, any>;

describe("inventory stock movements and stock levels", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const spec = loadSpec();
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const P = (tenant: string) => `/v1/tenants/${tenant}/inventory`;

  const call = (who: string, method: "GET" | "POST", path: string, payload?: unknown, opts: { tenant?: string; header?: string } = {}) => {
    const tenant = opts.tenant ?? ids.tenantA;
    return ctx.app.inject({
      method,
      url: `${P(tenant)}${path}`,
      headers: { authorization: `Bearer ${tok[who]}`, "x-tenant-id": opts.header ?? tenant },
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
  };
  const ok = async (who: string, method: "GET" | "POST", path: string, payload?: unknown, status = method === "POST" ? 201 : 200): Promise<Json> => {
    const res = await call(who, method, path, payload);
    expect(res.statusCode, `${method} ${path} ${res.body}`).toBe(status);
    return res.json();
  };
  const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);
  const conforms = (method: string, path: string, status: number, body: unknown) => {
    const schema = responseSchema(spec, method, `/v1/tenants/{tenantId}/inventory${path}`, status);
    expect(typeof schema, String(schema)).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, errs.join("; ")).toEqual([]);
  };

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
  async function whileChanged(change: string, undo: string, params: unknown[], fn: () => Promise<void>): Promise<void> {
    await q(change, params);
    try {
      await fn();
    } finally {
      await q(undo, params);
    }
  }
  /** A stock line in school A, made through the API. */
  async function stockItem(name: string, extra: Json = {}): Promise<string> {
    const body = await ok("admin", "POST", "/items", { name, category: "kitchen", tracking: "stock", quantity: 0, consumable: true, unit: "kg", ...extra });
    return body.item.id as string;
  }
  const move = (who: string, payload: Json) => call(who, "POST", "/movements", payload);
  const quantityOf = async (itemId: string) => (await q(`SELECT quantity FROM inventory_items WHERE id = $1`, [itemId])).rows[0].quantity as number;
  /** Run fn on a figbloom_app connection in a transaction with the given school and user, rolled back unless `commit`. */
  async function asApp<T>(tenant: string, user: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenant, user]);
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
    id.storeTeacher = await member("Store Teacher", "teacher", "TC-0002", A); // holds the Inventory area
    id.feesTeacher = await member("Fees Teacher", "teacher", "TC-0003", A); // holds another area
    id.adminB = await member("Admin B", "school_admin", "AD-0002", B);
    id.goneTeacher = await member("Gone Teacher", "teacher", "TC-0005", A); // holds the Inventory area until archived
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'inventory')`, [A, id.storeTeacher]);
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees')`, [A, id.feesTeacher]);
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'inventory')`, [A, id.goneTeacher]);

    tok.admin = await byEmail("admin-a@example.com");
    tok.orgAdmin = await byEmail("orgadmin@example.com");
    tok.adminB = await login(B, "AD-0002");
    tok.storeTeacher = await login(A, "TC-0002");
    tok.feesTeacher = await login(A, "TC-0003");
    tok.teacher = await login(A, "TC-0001");
    tok.parent = await login(A, "PT-0001");
    tok.goneTeacher = await login(A, "TC-0005");

    id.rice = await stockItem("Rice");
    expect((await move("admin", { item_id: id.rice, kind: "received", quantity: 50, occurred_on: "2026-01-05" })).statusCode).toBe(201);
    // school B's own stock line and movement, which school A must never see or touch
    const bItem = await q(`INSERT INTO inventory_items (tenant_id, name, category, tracking, quantity) VALUES ($1, 'B Beans', 'kitchen', 'stock', 0) RETURNING id`, [B]);
    id.bItem = bItem.rows[0].id;
    await q(`INSERT INTO inventory_movements (tenant_id, item_id, kind, quantity, occurred_on) VALUES ($1, $2, 'received', 40, '2026-01-05')`, [B, id.bItem]);
  }, 240_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("who may record and read stock", () => {
    const routes = (): Array<[string, "GET" | "POST", string, unknown]> => [
      ["record", "POST", "/movements", { item_id: id.rice, kind: "used", quantity: 1 }],
      ["list", "GET", "/movements", undefined],
      ["levels", "GET", "/stock-levels", undefined],
    ];

    it("a parent, a teacher without the Inventory area and a holder of another area get the audited 403, and nothing moves", async () => {
      const before = await quantityOf(id.rice!);
      for (const who of ["parent", "teacher", "feesTeacher"]) {
        for (const [what, method, path, payload] of routes()) {
          const res = await call(who, method, path, payload);
          expect(res.statusCode, `${who} ${what}`).toBe(403);
          expect(res.json().error.code).toBe("forbidden");
        }
      }
      expect(await quantityOf(id.rice!)).toBe(before);
      const denied = await q(
        `SELECT detail->>'permission' AS p FROM security_audit_events WHERE actor_user_id = $1 AND event_type = 'rbac.permission.denied'`,
        [ids.parentA],
      );
      expect(denied.rows.map((r) => r.p)).toEqual(expect.arrayContaining(["resource.inventory.write", "resource.inventory.read"]));
    });

    it("another school is refused by path and by header, and an item of another school is not found", async () => {
      for (const [what, method, path, payload] of routes()) {
        expect((await call("adminB", method, path, payload)).statusCode, `adminB ${what}`).toBe(403);
        expect((await call("admin", method, path, payload, { tenant: ids.tenantB })).statusCode, `path B ${what}`).toBe(403);
        expect((await call("admin", method, path, payload, { header: ids.tenantB })).statusCode, `header B ${what}`).toBe(403);
      }
      const bBefore = await q(`SELECT quantity FROM inventory_items WHERE id = $1`, [id.bItem]);
      const res = await move("admin", { item_id: id.bItem, kind: "used", quantity: 1 });
      expect(res.statusCode).toBe(404);
      expect((await q(`SELECT quantity FROM inventory_items WHERE id = $1`, [id.bItem])).rows).toEqual(bBefore.rows);
      // school A's lists never carry school B's rows
      const list = await ok("admin", "GET", "/movements?limit=200");
      expect(list.movements.every((m: Json) => m.tenant_id === ids.tenantA)).toBe(true);
      const levels = await ok("admin", "GET", "/stock-levels");
      expect(levels.levels.map((l: Json) => l.item_id)).not.toContain(id.bItem);
    });

    it("an org admin without a delegation is refused; a delegation of the Inventory area opens it", async () => {
      for (const [what, method, path, payload] of routes()) {
        expect((await call("orgAdmin", method, path, payload)).statusCode, `orgAdmin ${what}`).toBe(403);
      }
      await whileChanged(
        `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1, $2, $3, 'area.inventory', $3)`,
        `DELETE FROM org_admin_school_delegations WHERE delegate_user_id = $3 AND tenant_id = $2 AND organization_id = $1`,
        [ids.orgA, ids.tenantA, ids.orgAdmin],
        async () => {
          expect((await call("orgAdmin", "GET", "/stock-levels")).statusCode).toBe(200);
          expect((await call("orgAdmin", "GET", "/movements")).statusCode).toBe(200);
          const rec = await call("orgAdmin", "POST", "/movements", { item_id: id.rice, kind: "used", quantity: 1, occurred_on: "2026-01-06" });
          expect(rec.statusCode, rec.body).toBe(201);
          expect(rec.json().movement.recorded_by).toBe(ids.orgAdmin);
        },
      );
    });

    it("anonymous is 401; a suspended school and an archived member are 403", async () => {
      expect((await ctx.app.inject({ method: "GET", url: `${P(ids.tenantA)}/stock-levels` })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: "POST", url: `${P(ids.tenantA)}/movements`, payload: { item_id: id.rice, kind: "used", quantity: 1 } })).statusCode).toBe(401);
      await whileChanged(
        `UPDATE tenants SET status = 'suspended' WHERE id = $1`,
        `UPDATE tenants SET status = 'active' WHERE id = $1`,
        [ids.tenantA],
        async () => {
          for (const [what, method, path, payload] of routes()) expect((await call("admin", method, path, payload)).statusCode, what).toBe(403);
        },
      );
      // archiving a member also ends their areas (migration 010), so this one is used for nothing else
      expect((await call("goneTeacher", "GET", "/stock-levels")).statusCode).toBe(200);
      await q(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [id.goneTeacher, ids.tenantA]);
      expect((await call("goneTeacher", "GET", "/stock-levels")).statusCode).toBe(403);
      expect((await call("goneTeacher", "POST", "/movements", { item_id: id.rice, kind: "used", quantity: 1 })).statusCode).toBe(403);
    });

    it("a holder of the Inventory area records and reads; the school administrator too", async () => {
      const res = await move("storeTeacher", { item_id: id.rice, kind: "used", quantity: 2, occurred_on: "2026-01-06", purpose: "Lunch" });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().movement.recorded_by).toBe(id.storeTeacher);
      expect(res.json().movement.recorded_by_name).toBe("Store Teacher");
      expect((await call("storeTeacher", "GET", "/movements")).statusCode).toBe(200);
      expect((await call("admin", "GET", "/stock-levels")).statusCode).toBe(200);
    });
  });

  describe("what the database holds on its own", () => {
    it("school A's context reads none of school B's movements and cannot write one for school B", async () => {
      await asApp(ids.tenantA, ids.adminA, async (c) => {
        expect((await c.query(`SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id = $1`, [ids.tenantB])).rows[0].n).toBe(0);
        const all = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM inventory_movements`);
        expect(all.rows.map((r) => r.tenant_id)).toEqual([ids.tenantA]);
      });
      // for school B, naming school B's item: refused (the trigger cannot see the item; the policy refuses the row)
      await expect(
        asApp(ids.tenantA, ids.adminA, (c) =>
          c.query(`INSERT INTO inventory_movements (tenant_id, item_id, kind, quantity, occurred_on) VALUES ($1, $2, 'received', 5, '2026-01-07')`, [ids.tenantB, id.bItem]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // in school A, naming school B's item: refused
      await expect(
        asApp(ids.tenantA, ids.adminA, (c) =>
          c.query(`INSERT INTO inventory_movements (tenant_id, item_id, kind, quantity, occurred_on) VALUES ($1, $2, 'received', 5, '2026-01-07')`, [ids.tenantA, id.bItem]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // missing context sees nothing
      const c = await ctx.runtimePool.connect();
      try {
        expect((await c.query(`SELECT count(*)::int AS n FROM inventory_movements`)).rows[0].n).toBe(0);
      } finally {
        c.release();
      }
    });

    it("a movement is never rewritten or removed: the app role has no UPDATE or DELETE, and the trigger refuses the owner too", async () => {
      await expect(asApp(ids.tenantA, ids.adminA, (c) => c.query(`UPDATE inventory_movements SET note = 'x'`))).rejects.toMatchObject({ code: "42501" });
      await expect(asApp(ids.tenantA, ids.adminA, (c) => c.query(`DELETE FROM inventory_movements`))).rejects.toMatchObject({ code: "42501" });
      await expect(q(`UPDATE inventory_movements SET note = 'rewritten' WHERE tenant_id = $1`, [ids.tenantA])).rejects.toThrow(
        /cannot be changed/,
      );
      const grants = await q(
        `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'figbloom_app' AND table_name = 'inventory_movements' ORDER BY 1`,
      );
      expect(grants.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
      const forced = await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'inventory_movements'`);
      expect(forced.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it("the recorder is the request's user, whatever the row says", async () => {
      const row = await asApp(ids.tenantA, id.storeTeacher!, (c) =>
        c.query<{ recorded_by: string }>(
          `INSERT INTO inventory_movements (tenant_id, item_id, kind, quantity, occurred_on, recorded_by) VALUES ($1, $2, 'received', 1, '2026-01-07', $3) RETURNING recorded_by`,
          [ids.tenantA, id.rice, ids.adminA],
        ),
      );
      expect(row.rows[0]!.recorded_by).toBe(id.storeTeacher);
    });

    it("two connections taking the last 5 at once: the trigger lets exactly one through", async () => {
      const item = await stockItem("Maize flour DB", { quantity: 5 });
      const c1 = await ctx.runtimePool.connect();
      const c2 = await ctx.runtimePool.connect();
      try {
        for (const c of [c1, c2]) {
          await c.query("BEGIN");
          await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [ids.tenantA, ids.adminA]);
        }
        const insert = `INSERT INTO inventory_movements (tenant_id, item_id, kind, quantity, occurred_on) VALUES ($1, $2, 'used', 5, '2026-01-07')`;
        await c1.query(insert, [ids.tenantA, item]);
        const second = c2.query(insert, [ids.tenantA, item]).then(
          () => "inserted",
          (e: { code?: string; message?: string }) => `${e.code} ${e.message}`,
        );
        await new Promise((r) => setTimeout(r, 300)); // c2 is now waiting on c1's lock on the item
        await c1.query("COMMIT");
        const outcome = await second;
        expect(outcome).toMatch(/^23514 Only 0 kg of Maize flour DB in stock/);
        await c2.query("ROLLBACK");
      } finally {
        await c1.query("ROLLBACK").catch(() => undefined);
        await c2.query("ROLLBACK").catch(() => undefined);
        c1.release();
        c2.release();
      }
      expect(await quantityOf(item)).toBe(0);
    });
  });

  describe("items carry unit, consumable and reorder level", () => {
    it("a stock line keeps them; the item reads and the list return them; a stock line may start at 0", async () => {
      const created = await ok("admin", "POST", "/items", {
        name: "Cooking oil", category: "kitchen", tracking: "stock", quantity: 0, unit: " litres ", consumable: true, reorder_level: 10,
      });
      conforms("POST", "/items", 201, created);
      expect(created.item).toMatchObject({ quantity: 0, unit: "litres", consumable: true, reorder_level: 10 });
      const one = await ok("admin", "GET", `/items/${created.item.id}`);
      conforms("GET", "/items/{itemId}", 200, one);
      expect(one.item).toMatchObject({ unit: "litres", consumable: true, reorder_level: 10 });
      const list = await ok("admin", "GET", "/items?limit=200");
      expect(list.items.find((i: Json) => i.id === created.item.id)).toMatchObject({ unit: "litres", consumable: true });
      const plain = await ok("admin", "POST", "/items", { name: "Desk", category: "furniture", tracking: "asset" });
      expect(plain.item).toMatchObject({ unit: null, consumable: false, reorder_level: null, quantity: 1 });
    });

    it("an asset has no unit, is not consumable and has no reorder level; bad values are refused", async () => {
      for (const extra of [{ unit: "kg" }, { consumable: true }, { reorder_level: 2 }]) {
        const res = await call("admin", "POST", "/items", { name: "Projector", category: "ict", tracking: "asset", ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      for (const bad of [{ unit: "x".repeat(21) }, { unit: "" }, { reorder_level: -1 }, { quantity: -1 }, { consumable: "yes" }]) {
        const res = await call("admin", "POST", "/items", { name: "Chalk", category: "stationery", tracking: "stock", ...bad });
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }
    });
  });

  describe("recording a movement", () => {
    it("a delivery adds stock and sets the item's price; use, waste and a stock-take move it; each is audited", async () => {
      const item = await stockItem("Beans");
      const recv = await move("admin", { item_id: item, kind: "received", quantity: 40, unit_cost_cents: 15000, supplier: "  Mama Mboga ", reference: "DN-1", occurred_on: "2026-01-10" });
      expect(recv.statusCode, recv.body).toBe(201);
      conforms("POST", "/movements", 201, recv.json());
      expect(recv.json().movement).toMatchObject({ kind: "received", quantity: 40, unit_cost_cents: 15000, supplier: "Mama Mboga", reference: "DN-1", occurred_on: "2026-01-10", recorded_by: ids.adminA });
      expect(recv.json().item).toMatchObject({ id: item, quantity: 40 });
      expect((await q(`SELECT unit_cost_cents FROM inventory_items WHERE id = $1`, [item])).rows[0].unit_cost_cents).toBe("15000");
      const used = await move("admin", { item_id: item, kind: "used", quantity: 12, purpose: "Lunch", meals_served: 300, occurred_on: "2026-01-11" });
      expect(used.statusCode, used.body).toBe(201);
      expect(used.json().movement).toMatchObject({ purpose: "Lunch", meals_served: 300, unit_cost_cents: null, supplier: null });
      expect((await move("admin", { item_id: item, kind: "wasted", quantity: 3, purpose: "Spoilt", occurred_on: "2026-01-11" })).statusCode).toBe(201);
      expect((await move("admin", { item_id: item, kind: "adjusted", quantity: -2, note: "Stock-take", occurred_on: "2026-01-12" })).statusCode).toBe(201);
      expect((await move("admin", { item_id: item, kind: "adjusted", quantity: 1, occurred_on: "2026-01-12" })).statusCode).toBe(201);
      expect(await quantityOf(item)).toBe(40 - 12 - 3 - 2 + 1);
      // a delivery without a price keeps the item's price
      expect((await move("admin", { item_id: item, kind: "received", quantity: 5, occurred_on: "2026-01-13" })).statusCode).toBe(201);
      expect((await q(`SELECT unit_cost_cents FROM inventory_items WHERE id = $1`, [item])).rows[0].unit_cost_cents).toBe("15000");
      const audit = await q(
        `SELECT detail FROM security_audit_events WHERE event_type = 'inventory.movement.recorded' AND tenant_id = $1 AND detail->>'itemId' = $2`,
        [ids.tenantA, item],
      );
      expect(audit.rows.map((r) => r.detail.kind).sort()).toEqual(["adjusted", "adjusted", "received", "received", "used", "wasted"]);
    });

    it("the date defaults to the school's today and may not be in the future", async () => {
      const item = await stockItem("Salt", { quantity: 10 });
      const today = (await q(`SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date::text AS d`)).rows[0].d as string;
      const tomorrow = (await q(`SELECT ((now() AT TIME ZONE 'Africa/Nairobi')::date + 1)::text AS d`)).rows[0].d as string;
      const res = await move("admin", { item_id: item, kind: "used", quantity: 1 });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().movement.occurred_on).toBe(today);
      expect((await move("admin", { item_id: item, kind: "used", quantity: 1, occurred_on: tomorrow })).statusCode).toBe(400);
    });

    it("the sign rules and the fields of each kind are refused when broken, and nothing moves", async () => {
      const item = await stockItem("Sugar", { quantity: 10 });
      const bad: Json[] = [
        { kind: "received", quantity: -5 },
        { kind: "used", quantity: 0 },
        { kind: "adjusted", quantity: 0 },
        { kind: "wasted", quantity: -1 },
        { kind: "used", quantity: 1, supplier: "Someone" },
        { kind: "wasted", quantity: 1, unit_cost_cents: 100 },
        { kind: "adjusted", quantity: 1, unit_cost_cents: 100 },
        { kind: "received", quantity: 1, meals_served: 20 },
        { kind: "wasted", quantity: 1, meals_served: 20 },
        { kind: "received", quantity: 1, unit_cost_cents: -1 },
        { kind: "used", quantity: 1.5 },
        { kind: "borrowed", quantity: 1 },
        { kind: "used", quantity: 1, occurred_on: "2026-02-31" },
        { kind: "used", quantity: 1, recorded_by: ids.adminA },
        { kind: "used", quantity: 1, supplier: "x".repeat(161) },
        { kind: "used", quantity: 1, note: "x".repeat(1001) },
      ];
      for (const b of bad) {
        const res = await move("admin", { item_id: item, ...b });
        expect(res.statusCode, JSON.stringify(b)).toBe(400);
      }
      expect((await move("admin", { kind: "used", quantity: 1 })).statusCode).toBe(400);
      expect((await move("admin", { item_id: "not-a-uuid", kind: "used", quantity: 1 })).statusCode).toBe(400);
      expect(await quantityOf(item)).toBe(10);
    });

    it("stock never falls below zero, an asset and a written-off item take no movements, and an unknown item is 404", async () => {
      const item = await stockItem("Green grams", { quantity: 5 });
      const short = await move("admin", { item_id: item, kind: "used", quantity: 6, occurred_on: "2026-01-14" });
      expect(short.statusCode).toBe(409);
      expect(short.json().error.message).toBe("Only 5 kg of Green grams in stock");
      const correction = await move("admin", { item_id: item, kind: "adjusted", quantity: -6, occurred_on: "2026-01-14" });
      expect(correction.statusCode).toBe(409);
      expect(await quantityOf(item)).toBe(5);

      const asset = (await ok("admin", "POST", "/items", { name: "Fridge", category: "kitchen", tracking: "asset" })).item.id;
      const a = await move("admin", { item_id: asset, kind: "received", quantity: 1 });
      expect(a.statusCode).toBe(400);
      expect(a.json().error.message).toBe("Fridge is a single tracked item; only stock lines take deliveries and use");

      const old = await stockItem("Old flour", { quantity: 3 });
      expect((await call("admin", "POST", `/items/${old}/retire`)).statusCode).toBe(200);
      const r = await move("admin", { item_id: old, kind: "received", quantity: 1 });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.message).toBe("Old flour has been written off");

      expect((await move("admin", { item_id: randomUUID(), kind: "received", quantity: 1 })).statusCode).toBe(404);
    });

    it("stock never falls below what is out on issues (out, lost or damaged)", async () => {
      const books = (await ok("admin", "POST", "/items", { name: "Exercise books", category: "stationery", tracking: "stock", quantity: 10 })).item.id;
      await ok("admin", "POST", "/issues", { item_id: books, holder_user_id: ids.teacherA, quantity: 8 });
      const over = await move("admin", { item_id: books, kind: "used", quantity: 3, occurred_on: "2026-01-15" });
      expect(over.statusCode).toBe(409);
      expect(over.json().error.message).toBe("8 of Exercise books are out with people or not returned; the stock cannot fall below that");
      expect((await move("admin", { item_id: books, kind: "used", quantity: 2, occurred_on: "2026-01-15" })).statusCode).toBe(201);
      expect(await quantityOf(books)).toBe(8);
      // a delivery is never held back by what is out
      expect((await move("admin", { item_id: books, kind: "received", quantity: 4, occurred_on: "2026-01-16" })).statusCode).toBe(201);
    });

    it("two people using the last 5 kg at once: exactly one succeeds, the other is told what is left", async () => {
      const item = await stockItem("Maize flour", { quantity: 5 });
      const [x, y] = await Promise.all([
        move("admin", { item_id: item, kind: "used", quantity: 5, occurred_on: "2026-01-17" }),
        move("storeTeacher", { item_id: item, kind: "used", quantity: 5, occurred_on: "2026-01-17" }),
      ]);
      expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
      const loser = x.statusCode === 409 ? x : y;
      expect(loser.json().error.message).toBe("Only 0 kg of Maize flour in stock");
      expect(await quantityOf(item)).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM inventory_movements WHERE item_id = $1`, [item])).rows[0].n).toBe(1);
    });
  });

  describe("listing movements", () => {
    let item: string;
    const DAYS = ["2026-02-01", "2026-02-03", "2026-02-03", "2026-02-05", "2026-02-07", "2026-02-09", "2026-02-11"];

    beforeAll(async () => {
      item = await stockItem("Potatoes", { quantity: 100 });
      for (const day of DAYS) expect((await move("admin", { item_id: item, kind: "used", quantity: 1, occurred_on: day })).statusCode).toBe(201);
      // recorded later, about an earlier day: it sorts by the day it happened
      expect((await move("admin", { item_id: item, kind: "wasted", quantity: 1, occurred_on: "2026-02-02" })).statusCode).toBe(201);
    });

    it("newest day first, then the latest recorded; each row says who recorded it", async () => {
      const body = await ok("admin", "GET", `/movements?item_id=${item}&limit=200`);
      conforms("GET", "/movements", 200, body);
      const days = body.movements.map((m: Json) => m.occurred_on);
      expect(days).toEqual(["2026-02-11", "2026-02-09", "2026-02-07", "2026-02-05", "2026-02-03", "2026-02-03", "2026-02-02", "2026-02-01"]);
      const sameDay = body.movements.filter((m: Json) => m.occurred_on === "2026-02-03");
      expect(Date.parse(sameDay[0].created_at)).toBeGreaterThanOrEqual(Date.parse(sameDay[1].created_at));
      expect(body.movements.every((m: Json) => m.item_id === item && m.recorded_by_name === "Admin A")).toBe(true);
    });

    it("from and to narrow by day; an item filter keeps other items out", async () => {
      const body = await ok("admin", "GET", `/movements?item_id=${item}&from=2026-02-03&to=2026-02-07`);
      expect(body.movements.map((m: Json) => m.occurred_on)).toEqual(["2026-02-07", "2026-02-05", "2026-02-03", "2026-02-03"]);
      const all = await ok("admin", "GET", "/movements?from=2026-02-01&to=2026-02-11&limit=200");
      expect(all.movements.length).toBe(DAYS.length + 1);
    });

    it("pages in a fixed order; a cursor cannot be replayed under another filter or by another school; bad filters are refused", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const res = await call("admin", "GET", `/movements?item_id=${item}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(res.statusCode, res.body).toBe(200);
        seen.push(...res.json().movements.map((m: Json) => m.id));
        cursor = res.json().page.next_cursor;
        if (!cursor) break;
      }
      const whole = (await ok("admin", "GET", `/movements?item_id=${item}&limit=200`)).movements.map((m: Json) => m.id);
      expect(seen).toEqual(whole);
      const first = await ok("admin", "GET", `/movements?item_id=${item}&limit=3`);
      const token = encodeURIComponent(first.page.next_cursor);
      expect((await call("admin", "GET", `/movements?limit=3&cursor=${token}`)).statusCode).toBe(400);
      expect((await call("admin", "GET", `/movements?item_id=${item}&from=2026-02-02&limit=3&cursor=${token}`)).statusCode).toBe(400);
      expect((await call("adminB", "GET", `/movements?item_id=${item}&limit=3&cursor=${token}`, undefined, { tenant: ids.tenantB })).statusCode).toBe(400);
      for (const bad of ["item_id=nope", "from=2026-02-31", "to=yesterday", "from=2026-02-05&to=2026-02-01", "sort=occurred_on", "limit=0", "cursor=garbage-garbage"]) {
        expect((await call("admin", "GET", `/movements?${bad}`)).statusCode, bad).toBe(400);
      }
    });
  });

  describe("stock levels", () => {
    let rice: string;
    let sugar: string;

    beforeAll(async () => {
      rice = await stockItem("Pishori rice", { reorder_level: 20 });
      const moves: Json[] = [
        { kind: "received", quantity: 100, unit_cost_cents: 12000, supplier: "Mill A", occurred_on: "2025-12-01" },
        { kind: "received", quantity: 100, unit_cost_cents: 12000, supplier: "Mill A", occurred_on: "2026-01-10" },
        { kind: "received", quantity: 50, unit_cost_cents: 13000, supplier: "Mill A", occurred_on: "2026-02-01" },
        { kind: "used", quantity: 100, purpose: "Lunch", occurred_on: "2026-01-20" }, // before the 28 days
        { kind: "used", quantity: 30, purpose: "Lunch", meals_served: 400, occurred_on: "2026-02-05" },
        { kind: "used", quantity: 40, purpose: "Lunch", occurred_on: "2026-02-15" },
        { kind: "wasted", quantity: 5, occurred_on: "2026-02-20" },
        { kind: "received", quantity: 50, unit_cost_cents: 12500, supplier: "Mill B", occurred_on: "2026-02-21" },
        { kind: "adjusted", quantity: -3, occurred_on: "2026-02-25" },
        { kind: "used", quantity: 10, purpose: "Lunch", occurred_on: "2026-03-02" }, // after as_of
      ];
      for (const m of moves) {
        const res = await move("admin", { item_id: rice, ...m });
        expect(res.statusCode, `${JSON.stringify(m)} ${res.body}`).toBe(201);
      }
      sugar = await stockItem("Brown sugar", { quantity: 10, reorder_level: 10 });
    });

    it("the same maths as Supabase's inventory_stock_levels, as of a day", async () => {
      const body = await ok("admin", "GET", "/stock-levels?as_of=2026-02-28");
      conforms("GET", "/stock-levels", 200, body);
      expect(body.as_of).toBe("2026-02-28");
      const r = body.levels.find((l: Json) => l.item_id === rice);
      // on hand is today's count (the register's), as on Supabase: 100 + 100 + 50 - 100 - 30 - 40 - 5 + 50 - 3 - 10
      expect(r).toEqual({
        item_id: rice,
        name: "Pishori rice",
        category: "kitchen",
        unit: "kg",
        consumable: true,
        quantity: 112,
        reorder_level: 20,
        unit_cost_cents: 12500,
        value_cents: 112 * 12500,
        used_28d: 70, // 1 to 28 February
        wasted_28d: 5,
        avg_daily_use: 2.5, // 70 / 28
        days_of_cover: 44.8, // 112 / 2.5
        low: false,
        last_received_on: "2026-02-21",
        // delivery days in the 120 days to then: 1 Dec, 10 Jan, 1 Feb, 21 Feb; gaps 40, 22, 20; median 22
        next_delivery_on: "2026-03-15",
      });
      const s = body.levels.find((l: Json) => l.item_id === sugar);
      expect(s).toMatchObject({ quantity: 10, low: true, used_28d: 0, avg_daily_use: 0, days_of_cover: null, last_received_on: null, next_delivery_on: null, unit_cost_cents: null, value_cents: 0 });
    });

    it("only live stock lines of the school: no assets, no written-off lines; ordered by store then name", async () => {
      const body = await ok("admin", "GET", "/stock-levels");
      const names = body.levels.map((l: Json) => l.name);
      expect(names).not.toContain("Fridge");
      expect(names).not.toContain("Desk");
      expect(names).not.toContain("Old flour");
      expect(body.levels.every((l: Json) => typeof l.quantity === "number")).toBe(true);
      const keys = body.levels.map((l: Json) => `${l.category}|${l.name}`);
      expect(keys).toEqual([...keys].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)));
      const today = (await q(`SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date::text AS d`)).rows[0].d as string;
      expect(body.as_of).toBe(today);
      expect((await call("admin", "GET", "/stock-levels?as_of=2026-13-01")).statusCode).toBe(400);
    });
  });
});
