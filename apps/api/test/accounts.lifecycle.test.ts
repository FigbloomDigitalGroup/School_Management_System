import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setAccountNotifier, type AccountMessage } from "../src/modules/account/notifier.js";
import { verifyPassword } from "../src/modules/identity/password.js";
import { createTestApp } from "./support.js";

const PASSWORD = "correct-horse-battery";
const NEW_PW = "brand-new-passw0rd";

describe("account lifecycle: provisioning, invitations, recovery, deactivation (owner decision 6.1)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let su: string;
  let admin: string;
  let teacher: string;
  beforeAll(async () => {
    ctx = await createTestApp();
    su = await login({ email: "super@example.com", password: PASSWORD });
    admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    teacher = await login({ tenantId: ctx.ids.tenantA, loginId: "TC-0001", password: PASSWORD });
  }, 120_000);
  afterAll(async () => {
    setAccountNotifier(null);
    await ctx.app.close();
    await ctx.pool.end();
  });
  afterEach(() => setAccountNotifier(null));

  async function login(body: Record<string, unknown>): Promise<string> {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }
  const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown, tenant?: string) =>
    ctx.app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const A = () => ctx.ids.tenantA;
  const slug = () => "sch-" + randomUUID().slice(0, 8);
  const mail = () => `person-${randomUUID().slice(0, 8)}@example.com`;
  const userByEmail = async (e: string) => (await ctx.pool.query(`SELECT id, password_hash, status FROM users WHERE lower(email) = lower($1)`, [e])).rows[0];

  async function provision(adminEmail = mail()) {
    const r = await call("POST", "/v1/platform/schools", su, { school_name: "New School", slug: slug(), organization_name: "New Org", admin_email: adminEmail });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
    return { adminEmail, tenantId: r.json().school.tenant_id as string, token: r.json().invitation.token as string, invitationId: r.json().invitation.id as string };
  }

  it("only a super administrator can provision a school; no credentials exist until the invitation is accepted", async () => {
    const body = { school_name: "Denied School", slug: slug(), organization_name: "Org", admin_email: mail() };
    expect((await call("POST", "/v1/platform/schools", admin, body)).statusCode).toBe(403);
    expect((await call("POST", "/v1/platform/schools", teacher, body)).statusCode).toBe(403);
    expect((await call("POST", "/v1/platform/schools", undefined, body)).statusCode).toBe(401);
    expect((await call("POST", "/v1/platform/schools", su, { ...body, slug: "Bad Slug" })).statusCode).toBe(400);
    const p = await provision();
    expect((await userByEmail(p.adminEmail))).toBeUndefined(); // nobody exists yet
    expect((await ctx.pool.query(`SELECT status FROM tenants WHERE id = $1`, [p.tenantId])).rows[0].status).toBe("onboarding");
    const audit = await ctx.pool.query(`SELECT detail::text AS d FROM security_audit_events WHERE event_type = 'platform.school.provisioned' AND tenant_id = $1`, [p.tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].d).not.toContain(p.token);
  });

  it("the invited school administrator sets their own Argon2id password; token is single-use; the school becomes active", async () => {
    const p = await provision();
    expect((await call("POST", "/v1/invitations/accept", undefined, { token: p.token, password: "short" })).statusCode).toBe(400); // policy: token NOT consumed
    const ok = await call("POST", "/v1/invitations/accept", undefined, { token: p.token, password: NEW_PW, full_name: "First Admin" });
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
    expect(ok.json()).toEqual({ status: "accepted", tenant_id: p.tenantId });
    const u = await userByEmail(p.adminEmail);
    expect(u.status).toBe("active");
    expect(u.password_hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(NEW_PW, u.password_hash)).toBe(true);
    const m = (await ctx.pool.query(`SELECT role, login_id FROM school_memberships WHERE user_id = $1 AND tenant_id = $2`, [u.id, p.tenantId])).rows[0];
    expect(m).toMatchObject({ role: "school_admin", login_id: "AD-0001" });
    expect((await ctx.pool.query(`SELECT status FROM tenants WHERE id = $1`, [p.tenantId])).rows[0].status).toBe("active");
    expect((await login({ email: p.adminEmail, password: NEW_PW })).length).toBeGreaterThan(10);
    expect((await call("POST", "/v1/invitations/accept", undefined, { token: p.token, password: NEW_PW })).statusCode).toBe(400); // replay
    expect((await call("POST", "/v1/invitations/accept", undefined, { token: "x".repeat(43), password: NEW_PW })).statusCode).toBe(400); // unknown
  });

  it("staff invitations: authorised school administrators only, own school only, no duplicates, revocable, expiring", async () => {
    const e = mail();
    const url = `/v1/tenants/${A()}/invitations`;
    expect((await call("POST", url, teacher, { email: e, role: "teacher" }, A())).statusCode).toBe(403); // no permission
    expect((await call("POST", url, undefined, { email: e, role: "teacher" }, A())).statusCode).toBe(401);
    expect((await call("POST", url, admin, { email: e, role: "school_admin" }, A())).statusCode).toBe(403); // only a super admin invites admins
    expect((await call("POST", url, admin, { email: e, role: "parent" }, A())).statusCode).toBe(400);
    expect((await call("POST", `/v1/tenants/${ctx.ids.tenantB}/invitations`, admin, { email: e, role: "teacher" }, ctx.ids.tenantB)).statusCode).toBeGreaterThanOrEqual(403); // other school
    const inv = await call("POST", url, admin, { email: e, role: "teacher", full_name: "New Teacher" }, A());
    expect(inv.statusCode).toBe(201);
    expect(inv.json().invitation).toMatchObject({ role: "teacher", delivery: "not_configured", token: expect.any(String) });
    expect((await call("POST", url, admin, { email: e, role: "staff" }, A())).statusCode).toBe(409); // open invitation exists
    expect((await call("POST", url, admin, { email: "admin-a@example.com", role: "staff" }, A())).statusCode).toBe(409); // already a member
    // token is stored only as a hash
    const stored = await ctx.pool.query(`SELECT token_hash FROM account_tokens WHERE id = $1`, [inv.json().invitation.id]);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toContain(inv.json().invitation.token);
    // revoke -> unusable
    expect((await call("POST", `${url}/${inv.json().invitation.id}/revoke`, teacher, undefined, A())).statusCode).toBe(403);
    expect((await call("POST", `${url}/${inv.json().invitation.id}/revoke`, admin, undefined, A())).statusCode).toBe(200);
    expect((await call("POST", `${url}/${inv.json().invitation.id}/revoke`, admin, undefined, A())).statusCode).toBe(404);
    expect((await call("POST", "/v1/invitations/accept", undefined, { token: inv.json().invitation.token, password: NEW_PW })).statusCode).toBe(400);
    // a fresh invitation can be accepted; expired ones cannot
    const fresh = await call("POST", url, admin, { email: e, role: "teacher" }, A());
    expect(fresh.statusCode).toBe(201);
    await ctx.pool.query(`UPDATE account_tokens SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1`, [fresh.json().invitation.id]);
    expect((await call("POST", "/v1/invitations/accept", undefined, { token: fresh.json().invitation.token, password: NEW_PW })).statusCode).toBe(400);
    const again = await call("POST", url, admin, { email: e, role: "teacher" }, A());
    expect((await call("POST", "/v1/invitations/accept", undefined, { token: again.json().invitation.token, password: NEW_PW })).statusCode).toBe(200);
    const u = await userByEmail(e);
    expect((await ctx.pool.query(`SELECT role, login_id FROM school_memberships WHERE user_id = $1 AND tenant_id = $2`, [u.id, A()])).rows[0].role).toBe("teacher");
  });

  it("an existing account must be signed in as that account to accept an invitation; someone else's session or none is refused", async () => {
    const p = await provision();
    const inv = await call("POST", `/v1/tenants/${p.tenantId}/invitations`, undefined, { email: mail(), role: "staff" }, p.tenantId);
    expect(inv.statusCode).toBe(401);
    // the super admin invites admin-a's address into the new school
    const r = await call("POST", `/v1/tenants/${p.tenantId}/invitations`, su, { email: "admin-a@example.com", role: "staff" }, p.tenantId);
    expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
    const token = r.json().invitation.token as string;
    expect((await call("POST", "/v1/invitations/accept", undefined, { token, password: NEW_PW })).statusCode).toBe(401); // login required
    expect((await call("POST", "/v1/invitations/accept", su, { token, password: NEW_PW })).statusCode).toBe(401); // wrong account's session
    const before = (await userByEmail("admin-a@example.com")).password_hash;
    expect((await call("POST", "/v1/invitations/accept", admin, { token, password: NEW_PW })).statusCode).toBe(200);
    expect((await userByEmail("admin-a@example.com")).password_hash).toBe(before); // password of an existing account is never replaced
    expect((await ctx.pool.query(`SELECT 1 FROM school_memberships WHERE tenant_id = $1 AND user_id = $2`, [p.tenantId, ctx.ids.adminA])).rowCount).toBe(1);
  });

  it("delivery boundary: with a notifier that sends, the token is NOT returned; tokens never appear in the audit trail", async () => {
    const sent: AccountMessage[] = [];
    setAccountNotifier({ send: async (m) => (sent.push(m), "sent") });
    const e = mail();
    const r = await call("POST", `/v1/tenants/${A()}/invitations`, admin, { email: e, role: "driver" }, A());
    expect(r.statusCode).toBe(201);
    expect(r.json().invitation.delivery).toBe("sent");
    expect(r.json().invitation.token).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "invitation", email: e });
    const audit = await ctx.pool.query(`SELECT string_agg(detail::text, '') AS d FROM security_audit_events`);
    expect(audit.rows[0].d ?? "").not.toContain(sent[0]!.token);
  });

  it("password recovery is enumeration-safe, single-use, expiring and revokes every session", async () => {
    const sent: AccountMessage[] = [];
    setAccountNotifier({ send: async (m) => (sent.push(m), "sent") });
    const s1 = await call("POST", "/v1/auth/password-reset/request", undefined, { email: "admin-a@example.com" });
    const s2 = await call("POST", "/v1/auth/password-reset/request", undefined, { email: "nobody-" + randomUUID() + "@example.com" });
    expect(s1.statusCode).toBe(202);
    expect(s2.statusCode).toBe(202);
    expect(s1.json()).toEqual(s2.json()); // identical answer
    expect(sent).toHaveLength(1); // only the real account produced a message
    expect(sent[0]!.email).toBe("admin-a@example.com");
    const t1 = sent[0]!.token;
    // a newer request revokes the older token
    await call("POST", "/v1/auth/password-reset/request", undefined, { email: "admin-a@example.com" });
    const t2 = sent[1]!.token;
    expect((await call("POST", "/v1/auth/password-reset/complete", undefined, { token: t1, password: NEW_PW })).statusCode).toBe(400);
    const session = await login({ email: "admin-a@example.com", password: PASSWORD });
    expect((await call("GET", "/v1/auth/me", session)).statusCode).toBe(200);
    expect((await call("POST", "/v1/auth/password-reset/complete", undefined, { token: t2, password: "short" })).statusCode).toBe(400); // policy, token kept
    expect((await call("POST", "/v1/auth/password-reset/complete", undefined, { token: t2, password: NEW_PW })).statusCode).toBe(200);
    expect((await call("GET", "/v1/auth/me", session)).statusCode).toBe(401); // every session revoked
    expect((await call("POST", "/v1/auth/login/email", undefined, { email: "admin-a@example.com", password: PASSWORD })).statusCode).toBe(401);
    expect((await call("POST", "/v1/auth/login/email", undefined, { email: "admin-a@example.com", password: NEW_PW })).statusCode).toBe(200);
    expect((await call("POST", "/v1/auth/password-reset/complete", undefined, { token: t2, password: NEW_PW + "x" })).statusCode).toBe(400); // single use
    expect((await userByEmail("admin-a@example.com")).password_hash.startsWith("$argon2id$")).toBe(true);
    // expiry
    await call("POST", "/v1/auth/password-reset/request", undefined, { email: "admin-a@example.com" });
    await ctx.pool.query(`UPDATE account_tokens SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' WHERE token_hash = $1`, [
      (await ctx.pool.query(`SELECT token_hash FROM account_tokens WHERE kind = 'password_reset' AND used_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)).rows[0].token_hash,
    ]);
    expect((await call("POST", "/v1/auth/password-reset/complete", undefined, { token: sent[2]!.token, password: NEW_PW + "y" })).statusCode).toBe(400);
    // restore the shared fixture password for later tests
    await ctx.pool.query(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id = $1) WHERE id = $2`, [ctx.ids.teacherA, ctx.ids.adminA]);
    admin = await login({ email: "admin-a@example.com", password: PASSWORD });
  });

  it("administrator-issued reset: own school members only, never yourself or a platform administrator; revokes sessions", async () => {
    const url = (u: string) => `/v1/tenants/${A()}/members/${u}/password-reset`;
    expect((await call("POST", url(ctx.ids.teacherA), teacher, undefined, A())).statusCode).toBe(403);
    expect((await call("POST", url(ctx.ids.adminA), admin, undefined, A())).statusCode).toBe(404); // not yourself
    expect((await call("POST", url(randomUUID()), admin, undefined, A())).statusCode).toBe(404);
    expect((await call("POST", url(ctx.ids.teacherB), admin, undefined, A())).statusCode).toBe(404); // member of another school
    const r = await call("POST", url(ctx.ids.teacherA), admin, undefined, A());
    expect(r.statusCode).toBe(201);
    expect(r.json().reset).toMatchObject({ delivery: "not_configured", token: expect.any(String) });
    const before = await login({ tenantId: A(), loginId: "TC-0001", password: PASSWORD });
    // teacherA has no e-mail; completion by token still works (the token, not the e-mail, identifies the account)
    expect((await call("POST", "/v1/auth/password-reset/complete", undefined, { token: r.json().reset.token, password: NEW_PW })).statusCode).toBe(200);
    expect((await call("GET", "/v1/auth/me", before)).statusCode).toBe(401);
    teacher = await login({ tenantId: A(), loginId: "TC-0001", password: NEW_PW });
    await ctx.pool.query(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id = $1) WHERE id = $2`, [ctx.ids.adminA, ctx.ids.teacherA]);
    teacher = await login({ tenantId: A(), loginId: "TC-0001", password: PASSWORD });
  });

  it("deactivation archives the membership and revokes the person's sessions; not yourself, not platform admins, not outsiders", async () => {
    const e = mail();
    const inv = await call("POST", `/v1/tenants/${A()}/invitations`, admin, { email: e, role: "staff" }, A());
    await call("POST", "/v1/invitations/accept", undefined, { token: inv.json().invitation.token, password: NEW_PW });
    const u = await userByEmail(e);
    const staffToken = await login({ email: e, password: NEW_PW });
    const sel = await call("POST", `/v1/auth/tenant`, staffToken, { tenantId: A() }).catch(() => null);
    void sel;
    const d = (uid: string, tok = admin) => call("POST", `/v1/tenants/${A()}/members/${uid}/deactivate`, tok, undefined, A());
    expect((await d(u.id, teacher)).statusCode).toBe(403);
    expect((await d(ctx.ids.adminA)).statusCode).toBe(403); // yourself
    expect((await d(ctx.ids.superAdmin)).statusCode).toBe(403); // platform admin
    expect((await d(randomUUID())).statusCode).toBe(404);
    expect((await d(u.id)).statusCode).toBe(200);
    expect((await call("GET", "/v1/auth/me", staffToken)).statusCode).toBe(401); // last school => every session revoked
    expect((await d(u.id)).statusCode).toBe(404); // already inactive
    expect((await ctx.pool.query(`SELECT archived_at FROM school_memberships WHERE user_id = $1 AND tenant_id = $2`, [u.id, A()])).rows[0].archived_at).not.toBeNull();
    expect((await ctx.pool.query(`SELECT 1 FROM security_audit_events WHERE event_type = 'account.membership.deactivated' AND detail->>'targetUserId' = $1`, [u.id])).rowCount).toBe(1);
  });

  it("the application role cannot read or write account tokens directly; definer functions refuse missing actor context", async () => {
    const code = async (sql: string, params: unknown[] = []) => {
      try {
        await ctx.runtimePool.query(sql, params);
        return null;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(await code(`SELECT * FROM account_tokens`)).toBe("42501");
    expect(await code(`INSERT INTO account_tokens (kind, token_hash, user_id, expires_at) VALUES ('password_reset', repeat('a', 64), gen_random_uuid(), now() + interval '1 hour')`)).toBe("42501");
    // no actor/tenant GUC => refused
    expect(await code(`SELECT public.account_create_invitation($1::uuid, 'x@example.com', 'teacher', NULL, repeat('b', 64), now() + interval '1 hour')`, [A()])).toBe("42501");
    expect(await code(`SELECT * FROM public.platform_provision_school(NULL, 'O', 'S', 'slug-x', 'a@example.com', NULL, repeat('c', 64), now() + interval '1 hour')`)).toBe("42501");
  });

  it("bootstrap: refuses while a super administrator exists; otherwise creates exactly one with a one-time setup token and no default credentials", async () => {
    const env = { ...process.env, MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL!, BOOTSTRAP_ADMIN_EMAIL: "root@example.com", BOOTSTRAP_ADMIN_NAME: "Root", FIGBLOOM_BOOTSTRAP_CONFIRM: "yes" };
    const run = (e: NodeJS.ProcessEnv) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, ["scripts/bootstrap-admin.mjs"], { env: e, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (err) {
        const x = err as { status?: number; stderr?: string };
        return { code: x.status ?? 1, out: String(x.stderr ?? "") };
      }
    };
    expect(run({ ...env, FIGBLOOM_BOOTSTRAP_CONFIRM: "no" }).code).toBe(2); // unconfirmed
    expect(run(env).code).toBe(2); // a super administrator already exists
    const saved = (await ctx.pool.query(`SELECT user_id, role FROM platform_roles`)).rows;
    await ctx.pool.query(`DELETE FROM platform_roles`);
    try {
      const ok = run(env);
      expect(ok.code, ok.out).toBe(0);
      const token = ok.out.trim().split(/\r?\n/).pop()!;
      const u = await userByEmail("root@example.com");
      expect(u.status).toBe("invited");
      expect(u.password_hash).toBe("!"); // unusable: no default password
      expect((await call("POST", "/v1/auth/login/email", undefined, { email: "root@example.com", password: "!" })).statusCode).toBe(401);
      expect(run(env).code).toBe(2); // one-time
      expect((await call("POST", "/v1/auth/password-reset/complete", undefined, { token, password: NEW_PW })).statusCode).toBe(200);
      expect((await call("POST", "/v1/auth/login/email", undefined, { email: "root@example.com", password: NEW_PW })).statusCode).toBe(200);
      const logged = await ctx.pool.query(`SELECT detail::text AS d FROM security_audit_events WHERE event_type = 'platform.bootstrap'`);
      expect(logged.rows).toHaveLength(1);
      expect(logged.rows[0].d).not.toContain(token);
    } finally {
      await ctx.pool.query(`DELETE FROM platform_roles`);
      await ctx.pool.query(`DELETE FROM users WHERE lower(email) = 'root@example.com'`).catch(() => undefined);
      for (const r of saved) await ctx.pool.query(`INSERT INTO platform_roles (user_id, role) VALUES ($1, $2)`, [r.user_id, r.role]);
    }
  });
});
