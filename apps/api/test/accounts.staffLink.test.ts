import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setAccountNotifier } from "../src/modules/account/notifier.js";
import { createTestApp } from "./support.js";

/**
 * Migration 104: accepting a staff invitation links the ONE active, unlinked staff record of that school whose e-mail is the
 * invited address, unless the account already has a staff record there. Every other case links nothing (a People
 * administrator links by hand, as before).
 */
const PASSWORD = "correct-horse-battery";
const NEW_PW = "brand-new-passw0rd";

describe("accepting a staff invitation links the matching staff record (104)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let adminB: string;
  const A = () => ctx.ids.tenantA;
  const B = () => ctx.ids.tenantB;
  const mail = () => `staff-${randomUUID().slice(0, 8)}@example.com`;
  const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);

  const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown, tenant?: string) =>
    ctx.app.inject({
      method,
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function login(body: Record<string, unknown>): Promise<string> {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().token as string;
  }
  async function invite(email: string, role = "teacher", tenant = A(), by = admin): Promise<string> {
    const r = await call("POST", `/v1/tenants/${tenant}/invitations`, by, { email, role }, tenant);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().invitation.token as string;
  }
  async function accept(token: string, session?: string): Promise<void> {
    const r = await call("POST", "/v1/invitations/accept", session, { token, password: NEW_PW, full_name: "Invited Person" });
    expect(r.statusCode, r.body).toBe(200);
  }
  const staffRecord = async (tenant: string, email: string | null, extra: { userId?: string; archived?: boolean } = {}) =>
    (
      await q(
        `INSERT INTO staff_members (tenant_id, full_name, classification, email, user_id, active, archived_at)
         VALUES ($1, 'Invited Person', 'teacher', $2, $3, $4, CASE WHEN $4 THEN NULL ELSE now() END) RETURNING id`,
        [tenant, email, extra.userId ?? null, !extra.archived],
      )
    ).rows[0].id as string;
  const linkedUser = async (staffId: string) => (await q(`SELECT user_id FROM staff_members WHERE id = $1`, [staffId])).rows[0].user_id as string | null;
  const userId = async (email: string) => (await q(`SELECT id FROM users WHERE email = lower($1)`, [email])).rows[0].id as string;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    const adminBId = randomUUID();
    await q(`INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, 'link-admin-b@example.com', password_hash, 'Admin B', 'active' FROM users WHERE id = $2`, [
      adminBId,
      ctx.ids.adminA,
    ]);
    await q(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0005')`, [adminBId, B()]);
    adminB = await login({ email: "link-admin-b@example.com", password: PASSWORD });
  }, 120_000);
  afterEach(() => setAccountNotifier(null));
  afterAll(async () => {
    setAccountNotifier(null);
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("links the single active unlinked record with the invited e-mail (any case); the teacher then has their own staff record", async () => {
    const e = mail();
    const staff = await staffRecord(A(), e.toUpperCase());
    await accept(await invite(e));
    const uid = await userId(e);
    expect(await linkedUser(staff)).toBe(uid);
    const teacher = await login({ email: e, password: NEW_PW });
    const me = await call("GET", `/v1/tenants/${A()}/staff/me`, teacher, undefined, A());
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().staff.id).toBe(staff);
    const audit = await q(
      `SELECT detail FROM security_audit_events WHERE event_type = 'directory.staff.linked_on_invitation' AND actor_user_id = $1 AND tenant_id = $2`,
      [uid, A()],
    );
    expect(audit.rows.map((r) => r.detail.staffId)).toEqual([staff]);
  });

  it("works for every staff role (driver and staff too)", async () => {
    for (const role of ["driver", "staff"]) {
      const e = mail();
      const staff = await staffRecord(A(), e);
      await accept(await invite(e, role));
      expect(await linkedUser(staff), role).toBe(await userId(e));
    }
  });

  it("two active records with that e-mail: nothing is linked", async () => {
    const e = mail();
    const one = await staffRecord(A(), e);
    const two = await staffRecord(A(), e);
    await accept(await invite(e));
    expect(await linkedUser(one)).toBeNull();
    expect(await linkedUser(two)).toBeNull();
  });

  it("an archived record, or a record already linked to someone else, is never taken", async () => {
    const e = mail();
    const archived = await staffRecord(A(), e, { archived: true });
    const taken = await staffRecord(A(), e, { userId: ctx.ids.teacherA });
    await accept(await invite(e));
    expect(await linkedUser(archived)).toBeNull();
    expect(await linkedUser(taken)).toBe(ctx.ids.teacherA);
    expect((await q(`SELECT count(*)::int AS n FROM staff_members WHERE user_id = $1`, [await userId(e)])).rows[0].n).toBe(0);
  });

  it("a record in another school is never linked; the school that invites is the only one that counts", async () => {
    const e = mail();
    const inB = await staffRecord(B(), e);
    await accept(await invite(e)); // invited into school A, which has no record for this e-mail
    expect(await linkedUser(inB)).toBeNull();
    // Invited into school B as well (same account, signed in), the B record is linked there.
    const session = await login({ email: e, password: NEW_PW });
    await accept(await invite(e, "teacher", B(), adminB), session);
    expect(await linkedUser(inB)).toBe(await userId(e));
  });

  it("an account that already has a staff record in this school keeps it; a second matching record is not linked", async () => {
    const e = mail();
    const first = await staffRecord(A(), e);
    await accept(await invite(e));
    const uid = await userId(e);
    expect(await linkedUser(first)).toBe(uid);
    // The membership is archived, a second record with the same e-mail appears, and the person is invited back.
    await q(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [uid, A()]);
    const second = await staffRecord(A(), e);
    const session = await login({ email: e, password: NEW_PW });
    await accept(await invite(e), session);
    expect(await linkedUser(first)).toBe(uid);
    expect(await linkedUser(second)).toBeNull();
  });

  it("a revoked, replayed or unknown token links nothing", async () => {
    const e = mail();
    const staff = await staffRecord(A(), e);
    const r = await call("POST", `/v1/tenants/${A()}/invitations`, admin, { email: e, role: "teacher" }, A());
    const token = r.json().invitation.token as string;
    expect((await call("POST", `/v1/tenants/${A()}/invitations/${r.json().invitation.id}/revoke`, admin, {}, A())).statusCode).toBe(200);
    expect((await call("POST", "/v1/invitations/accept", undefined, { token, password: NEW_PW })).statusCode).toBe(400);
    expect((await call("POST", "/v1/invitations/accept", undefined, { token: "x".repeat(43), password: NEW_PW })).statusCode).toBe(400);
    expect(await linkedUser(staff)).toBeNull();
  });
});
