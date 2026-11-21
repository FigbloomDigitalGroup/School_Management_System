import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { workerHandlers } from "../src/worker/handlers.js";
import type { MpesaProvider } from "../src/modules/finance/mpesaProvider.js";
import { runCycle } from "../src/worker/runtime.js";
import { enableWorkerLogin, resetWorkerLogin } from "./support/financeHarness.js";
import { createPool, workerPoolOptions } from "../src/db/pool.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const PASSWORD = "correct-horse-battery";

const fakeProvider: MpesaProvider = {
  configured: false,
  async stkPush() {
    return { accepted: false, responseCode: "not_configured" };
  },
  async stkQuery() {
    return { done: false };
  },
};

describe("Stage 12 announcements", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;
  let workerPool: Awaited<ReturnType<typeof enableWorkerLogin>> | undefined;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const admin = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: PASSWORD },
    });
    expect(admin.statusCode).toBe(200);
    adminToken = admin.json().token as string;
    const teacher = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD },
    });
    expect(teacher.statusCode).toBe(200);
    teacherToken = teacher.json().token as string;
  }, 120_000);

  afterAll(async () => {
    if (workerPool) await workerPool.end().catch(() => undefined);
    await resetWorkerLogin(ctx.pool).catch(() => undefined);
    await ctx.app.close();
    await ctx.pool.end();
  });

  function headers(token: string, tenant = ids.tenantA) {
    return { authorization: `Bearer ${token}`, "x-tenant-id": tenant };
  }

  it("school admin creates, publishes, and teacher sees whole_school in inbox", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers: headers(adminToken),
      payload: {
        subject: "Term opening",
        body: "Welcome back to school.",
        audience: { kind: "whole_school" },
        channels: ["in_app", "push"],
      },
    });
    expect(created.statusCode).toBe(201);
    const announcement = created.json().announcement;
    expect(announcement.published_at).toBeNull();
    expect(announcement.channels).toEqual(["in_app", "push"]);

    const published = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${announcement.id}/publish`,
      headers: headers(adminToken),
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().announcement.published_at).toBeTruthy();

    const job = await ctx.pool.query<{ job_type: string; idempotency_key: string }>(
      `SELECT job_type, idempotency_key FROM jobs WHERE tenant_id = $1 AND job_type = 'announcement.push'`,
      [ids.tenantA],
    );
    expect(job.rows).toEqual([{ job_type: "announcement.push", idempotency_key: `announcement.push:${announcement.id}` }]);

    const inbox = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/inbox`,
      headers: headers(teacherToken),
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().announcements.some((a: { id: string }) => a.id === announcement.id)).toBe(true);

    const read = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${announcement.id}/read`,
      headers: headers(teacherToken),
    });
    expect(read.statusCode).toBe(204);
  });

  it("teacher without communication area cannot compose; inbox still works", async () => {
    const denied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers: headers(teacherToken),
      payload: { subject: "Nope", body: "Should fail", audience: { kind: "whole_school" }, channels: ["in_app"] },
    });
    expect(denied.statusCode).toBe(403);

    const inbox = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/inbox`,
      headers: headers(teacherToken),
    });
    expect(inbox.statusCode).toBe(200);
  });

  it("role-targeted audience excludes other roles; published content is immutable", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers: headers(adminToken),
      payload: {
        subject: "Admins only",
        body: "Admin notice",
        audience: { kind: "role", role: "school_admin" },
        channels: ["in_app"],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().announcement.id as string;
    const pub = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${id}/publish`,
      headers: headers(adminToken),
    });
    expect(pub.statusCode).toBe(200);

    const teacherInbox = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/inbox`,
      headers: headers(teacherToken),
    });
    expect(teacherInbox.json().announcements.some((a: { id: string }) => a.id === id)).toBe(false);

    const adminInbox = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/inbox`,
      headers: headers(adminToken),
    });
    expect(adminInbox.json().announcements.some((a: { id: string }) => a.id === id)).toBe(true);

    await expect(
      ctx.pool.query(`UPDATE communications_announcements SET subject = 'hacked' WHERE id = $1`, [id]),
    ).rejects.toThrow(/published announcement is final|23514/);
  });

  it("SMS/email channels record skipped_no_provider and do not invent a provider send", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers: headers(adminToken),
      payload: {
        subject: "Deferred channels",
        body: "SMS and email selected",
        audience: { kind: "whole_school" },
        channels: ["in_app", "sms", "email"],
      },
    });
    const id = created.json().announcement.id as string;
    const pub = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${id}/publish`,
      headers: headers(adminToken),
    });
    expect(pub.statusCode).toBe(200);
    const deliveries = await ctx.pool.query<{ channel: string; status: string }>(
      `SELECT channel, status FROM communications_announcement_deliveries
        WHERE tenant_id = $1 AND announcement_id = $2 ORDER BY channel`,
      [ids.tenantA, id],
    );
    expect(deliveries.rows).toEqual([
      { channel: "email", status: "skipped_no_provider" },
      { channel: "sms", status: "skipped_no_provider" },
    ]);
  });

  it("cross-tenant path access is refused", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers: headers(adminToken),
      payload: { subject: "Tenant A only", body: "Secret", audience: { kind: "whole_school" }, channels: ["in_app"] },
    });
    const id = created.json().announcement.id as string;
    const other = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/communications/announcements/${id}`,
      headers: headers(adminToken, ids.tenantB),
    });
    expect(other.statusCode).toBe(403);
  });

  it("worker announcement.push records a skipped_no_provider delivery under the job tenant", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers: headers(adminToken),
      payload: {
        subject: "Push job",
        body: "Worker path",
        audience: { kind: "whole_school" },
        channels: ["in_app", "push"],
      },
    });
    const id = created.json().announcement.id as string;
    await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${id}/publish`,
      headers: headers(adminToken),
    });
    // Only this announcement's job should be claimable (earlier tests may have queued siblings).
    await ctx.pool.query(
      `UPDATE jobs SET run_after = now() + interval '1 day'
        WHERE tenant_id = $1 AND job_type = 'announcement.push' AND idempotency_key <> $2`,
      [ids.tenantA, `announcement.push:${id}`],
    );
    await ctx.pool.query(
      `UPDATE jobs SET run_after = now() - interval '1 second'
        WHERE tenant_id = $1 AND job_type = 'announcement.push' AND idempotency_key = $2`,
      [ids.tenantA, `announcement.push:${id}`],
    );

    const login = await enableWorkerLogin(ctx.pool, ctx.runtimeUrl);
    workerPool = login;
    const pool = createPool(
      workerPoolOptions({
        databaseUrl: login.connectionString,
        poolMax: 1,
        poolAcquireTimeoutMs: 2_000,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleInTransactionSessionTimeoutMs: 15_000,
        clientQueryTimeoutMs: 20_000,
        applicationName: "figbloom-worker-announcements-test",
      }),
    );
    try {
      const handlers = workerHandlers(fakeProvider);
      const outcome = await runCycle(pool, {
        workerName: `ann-test-${process.pid}`,
        leaseSeconds: 60,
        handlers: { "announcement.push": handlers["announcement.push"]! },
      });
      expect(outcome).toBe("succeeded");
      const deliveries = await ctx.pool.query<{ status: string; channel: string }>(
        `SELECT channel, status FROM communications_announcement_deliveries
          WHERE tenant_id = $1 AND announcement_id = $2 AND channel = 'push'`,
        [ids.tenantA, id],
      );
      expect(deliveries.rows).toEqual([{ channel: "push", status: "skipped_no_provider" }]);
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});
