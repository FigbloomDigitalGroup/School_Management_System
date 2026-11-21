import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

/** FIG-1623 / AD-10: optional Idempotency-Key. */
describe("Idempotency-Key", () => {
  let ctx: Ctx;
  let adminToken: string;
  let superToken: string;
  let teacherToken: string;
  let learnerId: string;

  const login = async (email: string | null, loginId?: string) => {
    const r = await ctx.app.inject({
      method: "POST",
      url: email ? "/v1/auth/login/email" : "/v1/auth/login/login-id",
      payload: email
        ? { email, password: "correct-horse-battery" }
        : { tenantId: ctx.ids.tenantA, loginId, password: "correct-horse-battery" },
    });
    return r.json().token as string;
  };
  const headers = (token: string, key?: string) => ({
    authorization: `Bearer ${token}`,
    "x-tenant-id": ctx.ids.tenantA,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const newKey = () => `test-${randomUUID()}`;
  const learnerPost = (key: string | undefined, body: Record<string, unknown>, token = adminToken) =>
    ctx.app.inject({ method: "POST", url: `/v1/tenants/${ctx.ids.tenantA}/learners`, headers: headers(token, key), payload: body });
  const guardianPost = (key: string | undefined, name: string, token = adminToken) =>
    ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ctx.ids.tenantA}/guardians`,
      headers: headers(token, key),
      payload: { full_name: name, learners: [{ learner_id: learnerId, relationship: "mother" }] },
    });
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await ctx.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params)).rows[0]!.n);
  const adm = (() => {
    let n = 0;
    return () => `ID-${Date.now() % 100000}-${++n}`;
  })();

  beforeAll(async () => {
    ctx = await createTestApp();
    adminToken = await login("admin-a@example.com");
    superToken = await login("super@example.com");
    teacherToken = await login(null, "TC-0001");
    const l = await learnerPost(undefined, { admission_no: adm(), full_name: "Seed Learner", gender: "female" });
    expect(l.statusCode).toBe(201);
    learnerId = l.json().learner.id;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("(1) without the header nothing changes: a duplicate is the ordinary conflict", async () => {
    const body = { admission_no: adm(), full_name: "Plain", gender: "male" };
    expect((await learnerPost(undefined, body)).statusCode).toBe(201);
    expect((await learnerPost(undefined, body)).statusCode).toBe(409);
  });

  it("(2,3) first request creates; the same key and payload replays the original status with no second effect or audit event", async () => {
    const key = newKey();
    const body = { admission_no: adm(), full_name: "Once Only", gender: "female" };
    const auditBefore = await count(`SELECT 1 FROM security_audit_events WHERE event_type = 'directory.learner.created'`);
    const first = await learnerPost(key, body);
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    const again = await learnerPost(key, body);
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json().learner.id).toBe(first.json().learner.id);
    expect(again.json().learner.admission_no).toBe(body.admission_no);
    expect(await count(`SELECT 1 FROM learners WHERE admission_no = $1`, [body.admission_no])).toBe(1);
    expect(await count(`SELECT 1 FROM security_audit_events WHERE event_type = 'directory.learner.created'`)).toBe(auditBefore + 1);
  });

  it("(4) the same key with a different request is 422 idempotency_key_reused, including a different route", async () => {
    const key = newKey();
    const body = { admission_no: adm(), full_name: "Original", gender: "male" };
    expect((await learnerPost(key, body)).statusCode).toBe(201);
    const changed = await learnerPost(key, { ...body, full_name: "Changed" });
    expect(changed.statusCode).toBe(422);
    expect(changed.json().error.code).toBe("idempotency_key_reused");
    const otherRoute = await guardianPost(key, "Other Route Guardian");
    expect(otherRoute.statusCode).toBe(422);
    // Key order in the body does not matter.
    const reordered = await learnerPost(key, { gender: "male", full_name: "Original", admission_no: body.admission_no });
    expect(reordered.statusCode).toBe(201);
    expect(reordered.headers["idempotent-replayed"]).toBe("true");
  });

  it("(5) different keys with identical payloads are two independent effects", async () => {
    const a = await guardianPost(newKey(), "Twin Guardian");
    const b = await guardianPost(newKey(), "Twin Guardian");
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().guardian.id).not.toBe(b.json().guardian.id);
  });

  it("(6) concurrent identical requests produce exactly one effect, one audit event and one key row", async () => {
    const key = newKey();
    const body = { admission_no: adm(), full_name: "Concurrent", gender: "female" };
    const auditBefore = await count(`SELECT 1 FROM security_audit_events WHERE event_type = 'directory.learner.created'`);
    const res = await Promise.all(Array.from({ length: 10 }, () => learnerPost(key, body)));
    expect(res.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(res.map((r) => r.json().learner.id)).size).toBe(1);
    expect(res.filter((r) => r.headers["idempotent-replayed"] === "true").length).toBe(9);
    expect(await count(`SELECT 1 FROM learners WHERE admission_no = $1`, [body.admission_no])).toBe(1);
    expect(await count(`SELECT 1 FROM security_audit_events WHERE event_type = 'directory.learner.created'`)).toBe(auditBefore + 1);
    expect(await count(`SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1`, [key])).toBe(1);
  });

  it("(7) concurrent conflicting requests: one wins, the rest are 422", async () => {
    const key = newKey();
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) => learnerPost(key, { admission_no: adm(), full_name: `Racer ${i}`, gender: "male" })),
    );
    const codes = res.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 422)).toHaveLength(5);
  });

  it("(8,10) a failed first attempt leaves nothing (rollback) and the same key then succeeds; a deleted resource makes the replay a 409", async () => {
    const key = newKey();
    const bad = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ctx.ids.tenantA}/guardians`,
      headers: headers(adminToken, key),
      payload: { full_name: "Never Saved", learners: [{ learner_id: "00000000-0000-4000-8000-0000000000aa", relationship: "mother" }] },
    });
    expect(bad.statusCode).toBe(404);
    expect(await count(`SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1`, [key])).toBe(0);
    expect(await count(`SELECT 1 FROM guardians WHERE full_name = 'Never Saved'`)).toBe(0);
    const ok = await guardianPost(key, "Saved On Retry");
    expect(ok.statusCode).toBe(201);
    // Resource removed after the original request: the replay says so.
    await ctx.pool.query(`DELETE FROM guardians WHERE id = $1`, [ok.json().guardian.id]);
    const replay = await guardianPost(key, "Saved On Retry");
    expect(replay.statusCode).toBe(409);
  });

  it("(11) an expired key is treated as absent and replaced atomically; cleanup is not required for correctness", async () => {
    const key = newKey();
    const first = await guardianPost(key, "Expiring Guardian");
    expect(first.statusCode).toBe(201);
    await ctx.pool.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE idempotency_key = $1`, [key]);
    const second = await guardianPost(key, "Expiring Guardian");
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.json().guardian.id).not.toBe(first.json().guardian.id);
    expect(await count(`SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1`, [key])).toBe(1);
    // A DIFFERENT payload under an expired key is allowed too.
    await ctx.pool.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE idempotency_key = $1`, [key]);
    expect((await guardianPost(key, "Different Name After Expiry")).statusCode).toBe(201);
  });

  it("(12) housekeeping: deleting expired rows is safe and changes nothing for live keys", async () => {
    const live = newKey();
    expect((await guardianPost(live, "Live Key Guardian")).statusCode).toBe(201);
    await ctx.pool.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
    const replay = await guardianPost(live, "Live Key Guardian");
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });

  it("(14,15) keys are scoped to the actor: another user with the same key is independent", async () => {
    const key = newKey();
    const a = await guardianPost(key, "Shared Key Name", adminToken);
    const s = await guardianPost(key, "Shared Key Name", superToken);
    expect([a.statusCode, s.statusCode]).toEqual([201, 201]);
    expect(a.json().guardian.id).not.toBe(s.json().guardian.id);
    expect(await count(`SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1`, [key])).toBe(2);
  });

  it("(14,15) a denied actor stores no key and cannot replay another actor's key", async () => {
    const key = newKey();
    expect((await learnerPost(key, { admission_no: adm(), full_name: "Admin Made", gender: "male" })).statusCode).toBe(201);
    const denied = await learnerPost(key, { admission_no: adm(), full_name: "Teacher Attempt", gender: "male" }, teacherToken);
    expect(denied.statusCode).toBe(403);
    expect(await count(`SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1 AND actor_user_id = $2`, [key, ctx.ids.teacherA])).toBe(0);
  });

  it("key format is validated (400) before anything is stored", async () => {
    for (const bad of ["short", "has space in key", "x".repeat(129), "bad/char/slash123"]) {
      const r = await learnerPost(bad, { admission_no: adm(), full_name: "Bad Key", gender: "male" });
      expect(r.statusCode, bad).toBe(400);
    }
  });

  it("only a keyed fingerprint is stored: no body, no personal data; RLS isolates tenants", async () => {
    const key = newKey();
    expect((await guardianPost(key, "Fingerprint Only Person")).statusCode).toBe(201);
    const row = await ctx.pool.query(`SELECT * FROM idempotency_keys WHERE idempotency_key = $1`, [key]);
    const text = JSON.stringify(row.rows[0]);
    expect(row.rows[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(text).not.toContain("Fingerprint Only Person");
    expect(Object.keys(row.rows[0]).sort()).toEqual(
      ["actor_user_id", "created_at", "expires_at", "fingerprint", "id", "idempotency_key", "resource_id", "resource_type", "response_status", "route", "tenant_id"].sort(),
    );
    expect(new Date(row.rows[0].expires_at).getTime() - new Date(row.rows[0].created_at).getTime()).toBeGreaterThan(23.9 * 3600_000);

    // Tenant B cannot see tenant A's key through the runtime role.
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.ids.tenantB]);
      const other = await c.query(`SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1`, [key]);
      expect(other.rowCount).toBe(0);
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.ids.tenantA]);
      const own = await c.query(`SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1`, [key]);
      expect(own.rowCount).toBe(1);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("org-delegation grant: a concurrent duplicate is a success (one row), not a raw 500; the keyed grant replays", async () => {
    const body = { delegateUserId: ctx.ids.orgAdmin, permissionCodes: ["tenant.read"] };
    const post = (key?: string) =>
      ctx.app.inject({ method: "POST", url: "/v1/rbac/org-delegations", headers: headers(adminToken, key), payload: body });
    const res = await Promise.all(Array.from({ length: 6 }, () => post()));
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(
      await count(
        `SELECT 1 FROM org_admin_school_delegations WHERE delegate_user_id = $1 AND permission_code = 'tenant.read' AND revoked_at IS NULL`,
        [ctx.ids.orgAdmin],
      ),
    ).toBe(1);
    const key = newKey();
    const a = await post(key);
    const b = await post(key);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.json().granted).toEqual(["tenant.read"]);
  });
});
