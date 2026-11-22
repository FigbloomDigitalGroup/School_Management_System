import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/modules/identity/password.js";
import { createTestApp } from "./support.js";

const PASSWORD = "correct-horse-battery";
const NEW_PW = "brand-new-passw0rd";

describe("guardian invitation and account linking (migration 073)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let adminB: string;
  let teacher: string;
  let parent: string;
  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    teacher = await login({ tenantId: ctx.ids.tenantA, loginId: "TC-0001", password: PASSWORD });
    parent = await login({ tenantId: ctx.ids.tenantA, loginId: "PT-0001", password: PASSWORD });
    // a school administrator of tenant B (the shared fixture has none): created directly as the owner
    const bId = randomUUID();
    const hash = (await ctx.pool.query<{ h: string }>(`SELECT password_hash AS h FROM users WHERE id = $1`, [ctx.ids.adminA])).rows[0]!.h;
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, 'admin-b@example.com', $2, 'Admin B', 'active')`, [bId, hash]);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0001')`, [bId, ctx.ids.tenantB]);
    adminB = await login({ email: "admin-b@example.com", password: PASSWORD });
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function login(body: Record<string, unknown>): Promise<string> {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }
  const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown, tenant?: string) =>
    ctx.app.inject({
      method,
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const A = () => ctx.ids.tenantA;
  const mail = () => `guardian-${randomUUID().slice(0, 8)}@example.com`;
  const owner = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;

  async function seed(opts: { email?: string | null; phone?: string | null; tenant?: string } = {}) {
    const tenant = opts.tenant ?? A();
    const learner = (await owner(
      `INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Test Learner', 'female') RETURNING id`,
      [tenant, "G" + randomUUID().slice(0, 8)],
    ))[0].id as string;
    const guardian = (await owner(
      `INSERT INTO guardians (tenant_id, full_name, email, phone) VALUES ($1, 'Test Guardian', $2, $3) RETURNING id`,
      [tenant, opts.email === undefined ? mail() : opts.email, opts.phone === undefined ? "0712345678" : opts.phone],
    ))[0].id as string;
    await owner(`INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship) VALUES ($1, $2, $3, 'mother')`, [tenant, guardian, learner]);
    const email = (await owner(`SELECT email FROM guardians WHERE id = $1`, [guardian]))[0].email as string | null;
    return { tenant, learner, guardian, email };
  }
  const invite = (g: { tenant: string; guardian: string; learner: string }, method: "email" | "sms" = "email", token = admin) =>
    call("POST", `/v1/tenants/${g.tenant}/guardians/${g.guardian}/invitations`, token, { learner_id: g.learner, method }, g.tenant);
  const accept = (token: string, contact: string, extra: Record<string, unknown> = {}, bearer?: string) =>
    call("POST", "/v1/guardian-invitations/accept", bearer, { token, contact, confirm: true, ...extra });
  async function issue(g: Awaited<ReturnType<typeof seed>>, method: "email" | "sms" = "email") {
    const r = await invite(g, method);
    expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
    return { token: r.json().invitation.token as string, id: r.json().invitation.id as string };
  }
  const events = async (type: string, tenant = A()) =>
    owner(`SELECT actor_user_id, detail::text AS detail FROM security_audit_events WHERE event_type = $1 AND tenant_id = $2`, [type, tenant]);

  it("valid invitation: a new person confirms, gets a parent account, Argon2id password, and a live link to the learner", async () => {
    const g = await seed();
    const inv = await issue(g);
    const stored = (await owner(`SELECT token_hash, status, contact_value, delivery_status FROM guardian_invitations WHERE id = $1`, [inv.id]))[0];
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(inv.token); // only a hash is stored
    expect(stored).toMatchObject({ status: "pending", delivery_status: "not_configured" });
    const preview = await call("POST", "/v1/guardian-invitations/preview", undefined, { token: inv.token });
    expect(preview.json()).toMatchObject({ valid: true, relationship: "mother", contact_method: "email", existing_account: false });
    const ok = await accept(inv.token, g.email!.toUpperCase(), { password: NEW_PW, full_name: "New Parent" });
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
    expect(ok.json()).toEqual({ status: "accepted", tenant_id: g.tenant });
    const u = (await owner(`SELECT id, password_hash, status FROM users WHERE lower(email) = $1`, [g.email!.toLowerCase()]))[0];
    expect(u.password_hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(NEW_PW, u.password_hash)).toBe(true);
    expect((await owner(`SELECT role, login_id FROM school_memberships WHERE user_id = $1 AND tenant_id = $2`, [u.id, g.tenant]))[0]).toMatchObject({ role: "parent", login_id: expect.stringMatching(/^PT-\d{4}$/) });
    expect((await owner(`SELECT status, contact_verification FROM guardian_invitations WHERE id = $1`, [inv.id]))[0]).toMatchObject({ status: "accepted", contact_verification: "token_and_contact_echo" });
    const t = await login({ email: g.email, password: NEW_PW });
    const links = await call("GET", "/v1/me/guardian-links", t);
    expect(links.json().links).toEqual([{ tenant_id: g.tenant, guardian_id: g.guardian, learner_id: g.learner }]);
    // the staff list shows metadata with a masked contact and no token material
    const list = await call("GET", `/v1/tenants/${g.tenant}/guardian-invitations?status=accepted`, admin, undefined, g.tenant);
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(g.email!);
    expect(JSON.stringify(list.json())).not.toContain("token");
  });

  it("expired, revoked, replayed and invalid tokens are all refused with the same answer and create nothing", async () => {
    const g1 = await seed();
    const g2 = await seed();
    const g3 = await seed();
    const exp = await issue(g1);
    await owner(`UPDATE guardian_invitations SET created_at = now() - interval '3 days', expires_at = now() - interval '1 day' WHERE id = $1`, [exp.id]);
    const rev = await issue(g2);
    expect((await call("POST", `/v1/tenants/${A()}/guardian-invitations/${rev.id}/revoke`, admin, undefined, A())).statusCode).toBe(200);
    expect((await call("POST", `/v1/tenants/${A()}/guardian-invitations/${rev.id}/revoke`, admin, undefined, A())).statusCode).toBe(404); // not open any more
    const good = await issue(g3);
    expect((await accept(good.token, g3.email!, { password: NEW_PW })).statusCode).toBe(200);
    const bodies = new Set<string>();
    for (const [tok, c] of [[exp.token, g1.email!], [rev.token, g2.email!], [good.token, g3.email!], [randomUUID() + randomUUID(), g1.email!]] as const) {
      const r = await accept(tok, c, { password: NEW_PW });
      expect(r.statusCode).toBe(400);
      bodies.add(JSON.stringify(r.json().error.message));
    }
    expect(bodies.size).toBe(1);
    expect((await owner(`SELECT count(*)::int AS n FROM users WHERE lower(email) = ANY($1)`, [[g1.email!.toLowerCase(), g2.email!.toLowerCase()]]))[0].n).toBe(0);
    expect((await owner(`SELECT count(*)::int AS n FROM guardian_accounts WHERE guardian_id = $1`, [g3.guardian]))[0].n).toBe(1); // the replay added nothing
    expect((await owner(`SELECT status FROM guardian_invitations WHERE id = $1`, [exp.id]))[0].status).toBe("expired");
  });

  it("the wrong contact, a missing confirmation, or an archived learner relationship never links; the token stays usable by the right person", async () => {
    const g = await seed();
    const inv = await issue(g);
    expect((await accept(inv.token, "someone.else@example.com", { password: NEW_PW })).statusCode).toBe(400); // wrong guardian contact
    const noConfirm = await call("POST", "/v1/guardian-invitations/accept", undefined, { token: inv.token, contact: g.email, confirm: false, password: NEW_PW });
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json().error.message).toMatch(/confirmation/i);
    expect((await call("POST", "/v1/guardian-invitations/accept", undefined, { token: inv.token, contact: g.email, password: NEW_PW })).statusCode).toBe(400); // confirm missing
    expect((await owner(`SELECT status FROM guardian_invitations WHERE id = $1`, [inv.id]))[0].status).toBe("pending");
    expect((await owner(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [g.email!.toLowerCase()]))[0].n).toBe(0);
    // the intended learner relationship is archived: the invitation is dead
    await owner(`UPDATE guardian_links SET archived_at = now() WHERE guardian_id = $1`, [g.guardian]);
    expect((await accept(inv.token, g.email!, { password: NEW_PW })).statusCode).toBe(400);
    expect((await invite(g)).statusCode).toBe(404); // and a new one cannot be issued for a relationship that is not live
  });

  it("cross-tenant: another school's administrator cannot invite, list or revoke; another school's user cannot accept", async () => {
    const g = await seed();
    const inv = await issue(g);
    // school B's administrator naming school A in the path / header
    expect((await invite(g, "email", adminB)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call("GET", `/v1/tenants/${A()}/guardian-invitations`, adminB, undefined, A())).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call("POST", `/v1/tenants/${A()}/guardian-invitations/${inv.id}/revoke`, adminB, undefined, A())).statusCode).toBeGreaterThanOrEqual(403);
    // school B's own context cannot see or revoke school A's invitation
    expect((await call("POST", `/v1/tenants/${ctx.ids.tenantB}/guardian-invitations/${inv.id}/revoke`, adminB, undefined, ctx.ids.tenantB)).statusCode).toBe(404);
    expect((await call("GET", `/v1/tenants/${ctx.ids.tenantB}/guardian-invitations`, adminB, undefined, ctx.ids.tenantB)).json().invitations).toEqual([]);
    // the guardian id of school A used inside school B is not found
    const cross = await call("POST", `/v1/tenants/${ctx.ids.tenantB}/guardians/${g.guardian}/invitations`, adminB, { learner_id: g.learner, method: "email" }, ctx.ids.tenantB);
    expect(cross.statusCode).toBe(404);
    // an existing account of another person presenting its own bearer cannot take the invitation
    const other = await call("POST", "/v1/guardian-invitations/accept", teacher, { token: inv.token, contact: g.email, confirm: true });
    expect(other.statusCode).toBe(400); // no account matches the contact and no password given
    expect((await owner(`SELECT status FROM guardian_invitations WHERE id = $1`, [inv.id]))[0].status).toBe("pending");
  });

  it("a guardian record has at most one live login; one login links several guardian records (several learners); relinking = revoke + invite", async () => {
    const email = mail();
    const g1 = await seed({ email });
    const g2 = await seed({ email });
    const a = await issue(g1);
    expect((await accept(a.token, email, { password: NEW_PW })).statusCode).toBe(200);
    expect((await invite(g1)).statusCode).toBe(409); // duplicate association refused
    // second guardian record with the same e-mail: the EXISTING account must sign in; an anonymous caller cannot attach
    const b = await issue(g2);
    expect((await accept(b.token, email, { password: NEW_PW })).statusCode).toBe(401);
    const t = await login({ email, password: NEW_PW });
    expect((await accept(b.token, email, {}, t)).statusCode).toBe(200);
    const links = (await call("GET", "/v1/me/guardian-links", t)).json().links as { learner_id: string }[];
    expect(links.map((l) => l.learner_id).sort()).toEqual([g1.learner, g2.learner].sort());
    // relinking: revoke the live link (reason required), then a fresh invitation is allowed
    expect((await call("POST", `/v1/tenants/${A()}/guardians/${g1.guardian}/account-link/revoke`, admin, { reason: "x" }, A())).statusCode).toBe(400);
    expect((await call("POST", `/v1/tenants/${A()}/guardians/${g1.guardian}/account-link/revoke`, admin, { reason: "Wrong person linked" }, A())).statusCode).toBe(200);
    expect(((await call("GET", "/v1/me/guardian-links", t)).json().links as unknown[]).length).toBe(1);
    expect((await invite(g1)).statusCode).toBe(201);
    expect((await events("guardian.account.revoked")).some((e) => e.detail.includes(g1.guardian))).toBe(true);
  });

  it("concurrent acceptance of one token yields exactly one link", async () => {
    const g = await seed();
    const inv = await issue(g);
    const results = await Promise.all([accept(inv.token, g.email!, { password: NEW_PW }), accept(inv.token, g.email!, { password: NEW_PW }), accept(inv.token, g.email!, { password: NEW_PW })]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(2);
    expect((await owner(`SELECT count(*)::int AS n FROM guardian_accounts WHERE guardian_id = $1 AND revoked_at IS NULL`, [g.guardian]))[0].n).toBe(1);
    expect((await owner(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [g.email!.toLowerCase()]))[0].n).toBe(1);
  });

  it("a newer invitation supersedes the older one; only one is ever open", async () => {
    const g = await seed();
    const first = await issue(g);
    const second = await issue(g);
    expect((await accept(first.token, g.email!, { password: NEW_PW })).statusCode).toBe(400);
    expect((await owner(`SELECT status FROM guardian_invitations WHERE id = $1`, [first.id]))[0].status).toBe("superseded");
    expect((await owner(`SELECT count(*)::int AS n FROM guardian_invitations WHERE guardian_id = $1 AND status = 'pending'`, [g.guardian]))[0].n).toBe(1);
    expect((await accept(second.token, g.email!, { password: NEW_PW })).statusCode).toBe(200);
  });

  it("a phone invitation can only attach to an account the person is already signed in to (a phone number alone proves nothing)", async () => {
    const g = await seed({ phone: "0722000111" });
    const inv = await issue(g, "sms");
    expect((await accept(inv.token, "0722 000 111", { password: NEW_PW })).statusCode).toBe(401);
    expect((await accept(inv.token, "0799999999", {}, parent)).statusCode).toBe(400); // wrong number even when signed in
    expect((await accept(inv.token, "+254 0722 000 111".replace("+254 ", ""), {}, parent)).statusCode).toBe(200);
    expect((await owner(`SELECT user_id FROM guardian_accounts WHERE guardian_id = $1`, [g.guardian]))[0].user_id).toBe(ctx.ids.parentA);
    const none = await seed({ email: null, phone: null });
    expect((await invite(none, "email")).statusCode).toBe(400); // nothing to verify
  });

  it("only a school administrator may invite, list, revoke or unlink; unauthenticated callers get 401", async () => {
    const g = await seed();
    for (const tok of [teacher, parent]) {
      expect((await invite(g, "email", tok)).statusCode).toBe(403);
      expect((await call("GET", `/v1/tenants/${A()}/guardian-invitations`, tok, undefined, A())).statusCode).toBe(403);
      expect((await call("POST", `/v1/tenants/${A()}/guardians/${g.guardian}/account-link/revoke`, tok, { reason: "not allowed" }, A())).statusCode).toBe(403);
    }
    expect((await call("POST", `/v1/tenants/${g.tenant}/guardians/${g.guardian}/invitations`, undefined, { learner_id: g.learner, method: "email" }, g.tenant)).statusCode).toBe(401);
    expect((await owner(`SELECT count(*)::int AS n FROM guardian_invitations WHERE guardian_id = $1`, [g.guardian]))[0].n).toBe(0);
    // the database function itself refuses a non-administrator even when called with a forged-looking context
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [A(), ctx.ids.teacherA]);
      await expect(c.query(`SELECT public.guardian_create_invitation($1, $2, $3, 'email', $4, now() + interval '1 day')`, [A(), g.guardian, g.learner, "a".repeat(64)])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("deactivating the guardian's membership revokes the link in the database; a disabled account cannot accept", async () => {
    const g = await seed();
    const inv = await issue(g);
    expect((await accept(inv.token, g.email!, { password: NEW_PW })).statusCode).toBe(200);
    const uid = (await owner(`SELECT id FROM users WHERE lower(email) = $1`, [g.email!.toLowerCase()]))[0].id as string;
    const t = await login({ email: g.email, password: NEW_PW });
    expect((await call("GET", "/v1/me/guardian-links", t)).json().links).toHaveLength(1);
    expect((await call("POST", `/v1/tenants/${A()}/members/${uid}/deactivate`, admin, undefined, A())).statusCode).toBe(200);
    expect((await owner(`SELECT revoked_at, revoke_reason FROM guardian_accounts WHERE guardian_id = $1`, [g.guardian]))[0]).toMatchObject({ revoke_reason: "membership deactivated" });
    expect((await call("GET", "/v1/me/guardian-links", t)).statusCode).toBe(401); // sessions were revoked as well
    // a disabled account cannot be re-attached through a fresh invitation
    await owner(`UPDATE users SET status = 'disabled' WHERE id = $1`, [uid]);
    const again = await issue(g);
    expect((await accept(again.token, g.email!, {})).statusCode).toBe(401);
    expect((await owner(`SELECT count(*)::int AS n FROM guardian_accounts WHERE guardian_id = $1 AND revoked_at IS NULL`, [g.guardian]))[0].n).toBe(0);
  });

  it("audit history records every sensitive transition with ids and never a token or contact", async () => {
    const g = await seed();
    const inv = await issue(g);
    const created = (await events("guardian.invitation.created")).find((e) => e.detail.includes(inv.id));
    expect(created?.actor_user_id).toBe(ctx.ids.adminA);
    expect(created?.detail).not.toContain(inv.token);
    expect(created?.detail).not.toContain(g.email!);
    expect((await accept(inv.token, g.email!, { password: NEW_PW })).statusCode).toBe(200);
    const accepted = (await events("guardian.invitation.accepted")).find((e) => e.detail.includes(inv.id));
    expect(accepted).toBeDefined();
    expect(accepted!.detail).not.toContain(inv.token);
    expect(accepted!.detail).not.toContain(g.email!);
    const g2 = await seed();
    const i2 = await issue(g2);
    await call("POST", `/v1/tenants/${A()}/guardian-invitations/${i2.id}/revoke`, admin, undefined, A());
    expect((await events("guardian.invitation.revoked")).some((e) => e.detail.includes(i2.id))).toBe(true);
    // the audit table is append-only: a runtime-role statement cannot edit it
    const c = await ctx.runtimePool.connect();
    try {
      await expect(c.query(`UPDATE security_audit_events SET detail = '{}'::jsonb WHERE event_type = 'guardian.invitation.created'`)).rejects.toBeDefined();
    } finally {
      c.release();
    }
  });

  it("a failure part-way through acceptance rolls everything back (no user, no membership, no link) and the token still works afterwards", async () => {
    const g = await seed();
    const inv = await issue(g);
    await owner(`CREATE OR REPLACE FUNCTION public.zz_fail_link() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected failure'; END $f$`);
    await owner(`CREATE TRIGGER zz_fail_link BEFORE INSERT ON public.guardian_accounts FOR EACH ROW EXECUTE FUNCTION public.zz_fail_link()`);
    try {
      const r = await accept(inv.token, g.email!, { password: NEW_PW });
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(r.json())).not.toMatch(/injected|trigger|guardian_accounts/i);
    } finally {
      await owner(`DROP TRIGGER zz_fail_link ON public.guardian_accounts`);
      await owner(`DROP FUNCTION public.zz_fail_link()`);
    }
    expect((await owner(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [g.email!.toLowerCase()]))[0].n).toBe(0);
    expect((await owner(`SELECT status FROM guardian_invitations WHERE id = $1`, [inv.id]))[0].status).toBe("pending");
    expect((await accept(inv.token, g.email!, { password: NEW_PW })).statusCode).toBe(200);
  });

  it("database constraints hold even against an owner-level writer: one live login per guardian record, link bound to the guardian's school", async () => {
    const g = await seed();
    const inv = await issue(g);
    expect((await accept(inv.token, g.email!, { password: NEW_PW })).statusCode).toBe(200);
    const uid = (await owner(`SELECT user_id FROM guardian_accounts WHERE guardian_id = $1`, [g.guardian]))[0].user_id as string;
    const invId = (await owner(`SELECT id FROM guardian_invitations WHERE guardian_id = $1 LIMIT 1`, [g.guardian]))[0].id as string;
    // a second LIVE link for the same guardian record (even for another login) is refused by the unique index
    await expect(owner(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1, $2, $3, $4)`, [g.tenant, g.guardian, ctx.ids.parentA, invId])).rejects.toMatchObject({ code: "23505" });
    // a link naming school B for a school A guardian violates the composite foreign key
    await expect(owner(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id, revoked_at, revoke_reason) VALUES ($1, $2, $3, $4, now(), 'x')`, [ctx.ids.tenantB, g.guardian, uid, invId])).rejects.toMatchObject({ code: "23503" });
    // an invitation for school B naming a school A guardian violates the composite foreign key too
    await expect(owner(`INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, expires_at) VALUES ($1, $2, $3, 'email', 'x@example.com', repeat('b', 64), now() + interval '1 day')`, [ctx.ids.tenantB, g.guardian, g.learner])).rejects.toMatchObject({ code: "23503" });
  });

  it("the tables are owner-only: the runtime role has no direct privilege on tokens or links", async () => {
    const c = await ctx.runtimePool.connect();
    try {
      for (const t of ["guardian_invitations", "guardian_accounts"]) {
        await expect(c.query(`SELECT 1 FROM public.${t} LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      c.release();
    }
  });
});
