import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../src/modules/identity/password.js";
import { financeHarness, PASSWORD } from "./support/financeHarness.js";

/**
 * M-9 (residual closure, migration 078): operator reconciliation checked the administer permission, asked the provider, checked
 * again, and then settled in a LATER transaction, so authority could change between the last check and the mutation. The settlement
 * transaction now re-asserts the actor's authority itself (finance_assert_administer_actor): live account, live school-administrator
 * membership (or platform super administrator), active school, all read with row locks in the SAME transaction that settles.
 */
describe("M-9: authority is re-verified inside the settlement transaction", () => {
  const h = financeHarness();
  const F = (p: string) => `/v1/tenants/${h.A()}/finance${p}`;

  async function newAdmin() {
    const email = `m9-${randomUUID().slice(0, 8)}@example.com`;
    const id = (await h.owner(`INSERT INTO users (email, password_hash, full_name, status) VALUES ($1, $2, 'M9 Admin', 'active') RETURNING id`, [email, await hashPassword(PASSWORD)]))[0]!.id as string;
    await h.owner(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', $3)`, [id, h.A(), "AD-" + String(1000 + Math.floor(Math.random() * 8999))]);
    const token = await h.login({ email, password: PASSWORD });
    return { id, email, token };
  }
  async function pendingPayment() {
    const inv = await h.freshInvoice(1_000_000);
    const p = await h.startPrompt(inv, 100_000);
    return { id: p.payment.id as string, checkout: p.checkout as string };
  }
  const reconcile = (paymentId: string, token: string) =>
    h.call("POST", F(`/payments/${paymentId}/mpesa-reconciliation`), token, { action: "refresh", note: "M-9 reconciliation test" }, { "x-tenant-id": h.A() });

  /** A transaction as the application role with the given user and school context (like a request). */
  async function appTx<T>(user: string, tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await h.ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenant, user]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  const assertActor = (c: pg.PoolClient, tenant: string) => c.query(`SELECT public.finance_assert_administer_actor($1)`, [tenant]);

  it("control: a current school administrator reconciles normally", async () => {
    const admin = await newAdmin();
    const p = await pendingPayment();
    h.fake.onQuery = undefined;
    h.fake.queries.set(p.checkout, { done: true, resultCode: 1032 });
    const r = await reconcile(p.id, admin.token);
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    expect((await h.payment(p.id)).status).not.toBe("pending");
  });

  it("end to end: authority revoked while the provider is being asked is honoured; the payment is untouched", async () => {
    const admin = await newAdmin();
    const p = await pendingPayment();
    h.fake.queries.set(p.checkout, { done: true, resultCode: 1032 });
    h.fake.onQuery = async () => {
      await h.owner(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [admin.id, h.A()]);
    };
    try {
      const r = await reconcile(p.id, admin.token);
      expect(r.statusCode).toBeGreaterThanOrEqual(401);
      expect(r.statusCode).toBeLessThanOrEqual(403);
    } finally {
      h.fake.onQuery = undefined;
    }
    expect((await h.payment(p.id)).status).toBe("pending");
    expect(await h.owner(`SELECT 1 FROM finance_mpesa_events WHERE payment_id = $1 AND source = 'operator'`, [p.id])).toHaveLength(0);
  });

  it("the settlement-transaction guard itself: refuses a revoked membership, a disabled account, another school, a suspended school, a non-administrator; allows an administrator and a super administrator", async () => {
    const admin = await newAdmin();
    await appTx(admin.id, h.A(), (c) => assertActor(c, h.A())); // current administrator: allowed
    await appTx(h.ids.superAdmin, h.A(), (c) => assertActor(c, h.A())); // platform super administrator: allowed
    await expect(appTx(h.ids.teacherA, h.A(), (c) => assertActor(c, h.A()))).rejects.toMatchObject({ code: "42501" }); // teacher
    await expect(appTx(admin.id, h.A(), (c) => assertActor(c, h.ids.tenantB))).rejects.toMatchObject({ code: "42501" }); // forged tenant parameter
    await expect(appTx(admin.id, h.ids.tenantB, (c) => assertActor(c, h.ids.tenantB))).rejects.toMatchObject({ code: "42501" }); // no membership there
    await h.owner(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [h.A()]);
    try {
      await expect(appTx(admin.id, h.A(), (c) => assertActor(c, h.A()))).rejects.toMatchObject({ code: "42501" });
    } finally {
      await h.owner(`UPDATE tenants SET status = 'active' WHERE id = $1`, [h.A()]);
    }
    await h.owner(`UPDATE users SET status = 'disabled' WHERE id = $1`, [admin.id]);
    await expect(appTx(admin.id, h.A(), (c) => assertActor(c, h.A()))).rejects.toMatchObject({ code: "42501" });
    await h.owner(`UPDATE users SET status = 'active' WHERE id = $1`, [admin.id]);
    await h.owner(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [admin.id, h.A()]);
    await expect(appTx(admin.id, h.A(), (c) => assertActor(c, h.A()))).rejects.toMatchObject({ code: "42501" });
    // no user or school context at all
    const c = await h.ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await expect(assertActor(c, h.A())).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("race: a revocation cannot slip in while the settlement transaction holds the authority (it waits), and one that committed first is seen", async () => {
    const admin = await newAdmin();
    const settling = await h.ctx.runtimePool.connect();
    try {
      await settling.query("BEGIN");
      await settling.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [h.A(), admin.id]);
      await assertActor(settling, h.A()); // authority verified and row-locked; the settlement would follow in this transaction
      // a concurrent revocation (membership archive, account disable, school suspension) must WAIT for this transaction
      const attempts: [string, unknown[]][] = [
        [`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [admin.id, h.A()]],
        [`UPDATE users SET status = 'disabled' WHERE id = $1`, [admin.id]],
        [`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [h.A()]],
      ];
      for (const [sql, params] of attempts) {
        const other = await h.ctx.pool.connect();
        try {
          await other.query("BEGIN");
          await other.query("SET LOCAL lock_timeout = '400ms'");
          await expect(other.query(sql, params), sql).rejects.toMatchObject({ code: "55P03" }); // blocked by the settlement's lock
        } finally {
          await other.query("ROLLBACK").catch(() => undefined);
          other.release();
        }
      }
      await settling.query("COMMIT");
    } finally {
      await settling.query("ROLLBACK").catch(() => undefined);
      settling.release();
    }
    // after the settlement transaction ended the revocation proceeds and the next attempt is refused
    await h.owner(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [admin.id, h.A()]);
    await expect(appTx(admin.id, h.A(), (c) => assertActor(c, h.A()))).rejects.toMatchObject({ code: "42501" });
  });
});
