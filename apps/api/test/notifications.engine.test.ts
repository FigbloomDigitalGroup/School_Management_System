import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { workerHandlers } from "../src/worker/handlers.js";
import { runCycle } from "../src/worker/runtime.js";
import { mpesaProviderFromConfig } from "../src/modules/finance/mpesaProvider.js";
import { FcmPushProvider, MockPushProvider, NotConfiguredPushProvider } from "../src/modules/notifications/pushProvider.js";
import { createPool } from "../src/db/pool.js";

const PASSWORD = "correct-horse-battery";

async function login(app: Awaited<ReturnType<typeof createTestApp>>["app"], email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  return res.json().token as string;
}

async function loginId(app: Awaited<ReturnType<typeof createTestApp>>["app"], tenantId: string, loginIdVal: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/login-id",
    payload: { tenantId, loginId: loginIdVal, password: PASSWORD },
  });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  return res.json().token as string;
}

describe("Stage 2: Central Notification Engine + Push (migration 089)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let workerPool: ReturnType<typeof createPool>;
  let adminToken: string;
  let teacherAToken: string;
  let parentAToken: string;
  let teacherBToken: string;
  let mockFcmServer: Server;
  let mockFcmPort: number;
  let fcmResponses: Array<{ status: number; body: Record<string, unknown> }> = [];
  let fcmRequests: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;

    // Provision worker pool using the same test database with figbloom_worker login role
    const workerPassword = `wrk_${randomUUID().replace(/-/g, "")}`;
    await ctx.pool.query(`ALTER ROLE figbloom_worker WITH LOGIN PASSWORD '${workerPassword}'`);
    const workerUrl = new URL(process.env.MIGRATION_DATABASE_URL!);
    workerUrl.username = "figbloom_worker";
    workerUrl.password = workerPassword;
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2, applicationName: "figbloom-test-worker" });

    adminToken = await login(ctx.app, "admin-a@example.com");
    teacherAToken = await loginId(ctx.app, ids.tenantA, "TC-0001");
    parentAToken = await loginId(ctx.app, ids.tenantA, "PT-0001");
    teacherBToken = await loginId(ctx.app, ids.tenantB, "TC-0001");

    // Local mock FCM HTTP v1 server (never calls live Google FCM)
    mockFcmServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        fcmRequests.push({ url: req.url ?? "", auth: req.headers.authorization, body: parsed });
        const next = fcmResponses.shift() ?? { status: 200, body: { name: "projects/test/messages/m-1" } };
        res.statusCode = next.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => {
      mockFcmServer.listen(0, "127.0.0.1", () => {
        const addr = mockFcmServer.address();
        mockFcmPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (mockFcmServer) await new Promise<void>((resolve) => mockFcmServer.close(() => resolve()));
    if (workerPool) await workerPool.end();
    if (ctx) {
      await ctx.app.close();
      await ctx.pool.end();
    }
  });

  it("enqueues durable outbox, processes worker idempotently, delivers in-app + mock push, supports read-state & enforces isolation", async () => {
    // Register device token for parentA
    const devRes = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/device-tokens",
      headers: { authorization: `Bearer ${parentAToken}` },
      payload: { token: "fcm-device-token-parent-a-0001", platform: "android" },
    });
    expect(devRes.statusCode).toBe(201);
    const deviceId = devRes.json().device_token.id as string;
    // Device token must never be exposed in API responses
    expect(JSON.stringify(devRes.json())).not.toContain("fcm-device-token-parent-a-0001");

    const listDev = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/device-tokens",
      headers: { authorization: `Bearer ${parentAToken}` },
    });
    expect(listDev.statusCode).toBe(200);
    expect(JSON.stringify(listDev.json())).not.toContain("fcm-device-token-parent-a-0001");

    // Admin enqueues notification for parentA (and an invalid cross-tenant recipient teacherB)
    const idemKey = `test-notice-${randomUUID()}`;
    const enq1 = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        category: "transport",
        recipient_user_ids: [ids.parentA, ids.teacherB],
        title: "School bus update",
        body: "Route A has departed.",
        channels: ["in_app", "push", "sms", "email"],
        idempotency_key: idemKey,
      },
    });
    expect(enq1.statusCode, JSON.stringify(enq1.json())).toBe(201);
    const outboxId = enq1.json().outbox_id as string;

    // Duplicate enqueue with same idempotency_key is idempotent
    const enq2 = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        category: "transport",
        recipient_user_ids: [ids.parentA],
        title: "School bus update",
        body: "Route A has departed.",
        channels: ["in_app", "push"],
        idempotency_key: idemKey,
      },
    });
    expect(enq2.statusCode).toBe(200);
    expect(enq2.json().created).toBe(false);
    expect(enq2.json().outbox_id).toBe(outboxId);

    // Non-admin (teacherA) cannot enqueue or view outbox
    const denied = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox`,
      headers: { authorization: `Bearer ${teacherAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(denied.statusCode).toBe(403);

    // Run worker with MockPushProvider
    const mockPush = new MockPushProvider();
    const handlers = workerHandlers(mpesaProviderFromConfig(ctx.app.appConfig), { pushProvider: mockPush });
    const outcome = await runCycle(workerPool, { workerName: "test-notif-worker", leaseSeconds: 60, handlers });
    expect(outcome).toBe("succeeded");
    expect(mockPush.sent).toHaveLength(1);
    expect(mockPush.sent[0]!.token).toBe("fcm-device-token-parent-a-0001");

    // ParentA sees in-app notification & unread count = 1
    const unread1 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications/unread-count`,
      headers: { authorization: `Bearer ${parentAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(unread1.statusCode).toBe(200);
    expect(unread1.json().unread_count).toBe(1);

    const list1 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications?unread_only=true&category=transport`,
      headers: { authorization: `Bearer ${parentAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(list1.statusCode).toBe(200);
    expect(list1.json().notifications).toHaveLength(1);
    const notifId = list1.json().notifications[0].id as string;

    // TeacherA (different user in same tenant) CANNOT read or mutate ParentA's notification
    const crossUserRead = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/${notifId}/read`,
      headers: { authorization: `Bearer ${teacherAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(crossUserRead.statusCode).toBe(404);

    // Cross-tenant access denied
    const crossTenant = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications`,
      headers: { authorization: `Bearer ${teacherBToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(crossTenant.statusCode).toBe(403);

    // ParentA marks notification read
    const markRead = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/${notifId}/read`,
      headers: { authorization: `Bearer ${parentAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(markRead.statusCode).toBe(200);
    expect(markRead.json().notification.read_at).toBeTruthy();

    const unread2 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications/unread-count`,
      headers: { authorization: `Bearer ${parentAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(unread2.json().unread_count).toBe(0);

    // Operational visibility: admin inspects outbox detail (sees delivered in_app + push, invalid_recipient for teacherB, not_configured for sms/email)
    const detail = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox/${outboxId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().outbox.status).toBe("partial");
    const attempts = detail.json().attempts as Array<{ channel: string; status: string; recipient_user_id: string }>;
    expect(attempts.some((a) => a.channel === "in_app" && a.status === "delivered" && a.recipient_user_id === ids.parentA)).toBe(true);
    expect(attempts.some((a) => a.channel === "push" && a.status === "delivered" && a.recipient_user_id === ids.parentA)).toBe(true);
    expect(attempts.some((a) => a.channel === "sms" && a.status === "not_configured")).toBe(true);
    expect(attempts.some((a) => a.channel === "email" && a.status === "not_configured")).toBe(true);
    expect(attempts.some((a) => a.status === "invalid_recipient" && a.recipient_user_id === ids.teacherB)).toBe(true);

    // Revoke device token -> subsequent notifications must NOT push to the revoked device
    const rev = await ctx.app.inject({
      method: "POST",
      url: `/v1/me/device-tokens/${deviceId}/revoke`,
      headers: { authorization: `Bearer ${parentAToken}` },
    });
    expect(rev.statusCode).toBe(204);

    const enqAfterRevoke = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        category: "transport",
        recipient_user_ids: [ids.parentA],
        title: "After revoke",
        body: "Should be in-app only",
        channels: ["in_app", "push"],
        idempotency_key: `after-revoke-${randomUUID()}`,
      },
    });
    expect(enqAfterRevoke.statusCode).toBe(201);
    const mockPush2 = new MockPushProvider();
    const out2 = await runCycle(workerPool, {
      workerName: "test-notif-worker",
      leaseSeconds: 60,
      handlers: workerHandlers(mpesaProviderFromConfig(ctx.app.appConfig), { pushProvider: mockPush2 }),
    });
    expect(out2).toBe("succeeded");
    expect(mockPush2.sent).toHaveLength(0);

    // Mark all read works
    const markAll = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/read-all`,
      headers: { authorization: `Bearer ${parentAToken}`, "x-tenant-id": ids.tenantA },
      payload: { category: "transport" },
    });
    expect(markAll.statusCode).toBe(200);
    expect(markAll.json().marked_count).toBe(1);
  });

  it("handles FCM HTTP v1 retries idempotently, auto-revokes UNREGISTERED tokens, and reports unconfigured provider honestly", async () => {
    fcmRequests = [];
    // Register a fresh device token for teacherA
    const devRes = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/device-tokens",
      headers: { authorization: `Bearer ${teacherAToken}` },
      payload: { token: "fcm-live-mock-token-teacher-a-0001", platform: "ios" },
    });
    expect(devRes.statusCode).toBe(201);

    const fcmProvider = new FcmPushProvider({
      projectId: "figbloom-test-proj",
      accessToken: "mock-oauth-token",
      endpointBaseUrl: `http://127.0.0.1:${mockFcmPort}`,
    });

    // 1. Transient 503 followed by 200 on retry (in-app must NOT duplicate!)
    fcmResponses = [
      { status: 503, body: { error: { status: "UNAVAILABLE" } } },
      { status: 200, body: { name: "projects/figbloom-test-proj/messages/ok-42" } },
    ];
    const enq = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        category: "medication",
        recipient_user_ids: [ids.teacherA],
        title: "Medication reminder",
        body: "Please check the health schedule.",
        channels: ["in_app", "push"],
        idempotency_key: `fcm-retry-${randomUUID()}`,
      },
    });
    expect(enq.statusCode).toBe(201);
    const outboxId = enq.json().outbox_id as string;

    const handlers = workerHandlers(mpesaProviderFromConfig(ctx.app.appConfig), { pushProvider: fcmProvider });
    const first = await runCycle(workerPool, { workerName: "test-fcm-worker", leaseSeconds: 60, handlers });
    expect(first).toBe("retry");

    // Fast-forward run_after for immediate retry test
    await ctx.pool.query(`UPDATE jobs SET run_after = now() - interval '1 second' WHERE tenant_id = $1 AND job_type = 'notification.dispatch'`, [ids.tenantA]);

    const second = await runCycle(workerPool, { workerName: "test-fcm-worker", leaseSeconds: 60, handlers });
    expect(second).toBe("succeeded");
    expect(fcmRequests).toHaveLength(2);
    expect(fcmRequests[0]!.url).toBe("/v1/projects/figbloom-test-proj/messages:send");
    expect(fcmRequests[0]!.auth).toBe("Bearer mock-oauth-token");

    // Verify teacherA has exactly ONE in-app notification (no duplicate on retry!)
    const notifList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications?category=medication`,
      headers: { authorization: `Bearer ${teacherAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(notifList.json().notifications).toHaveLength(1);

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox/${outboxId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(detail.json().outbox.status).toBe("completed");

    // 2. FCM returns 404 UNREGISTERED -> token is automatically revoked
    fcmResponses = [
      { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } },
    ];
    await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        category: "medication",
        recipient_user_ids: [ids.teacherA],
        title: "Invalid token test",
        body: "Should auto-revoke token",
        channels: ["in_app", "push"],
        idempotency_key: `fcm-unreg-${randomUUID()}`,
      },
    });
    const third = await runCycle(workerPool, { workerName: "test-fcm-worker", leaseSeconds: 60, handlers });
    expect(third).toBe("succeeded");

    const tokRow = await ctx.pool.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      `SELECT revoked_at, revoked_reason FROM device_tokens WHERE token = 'fcm-live-mock-token-teacher-a-0001'`,
    );
    expect(tokRow.rows[0]?.revoked_at).not.toBeNull();
    expect(tokRow.rows[0]?.revoked_reason).toBe("fcm_unregistered");

    // 3. NotConfiguredPushProvider records truthful not_configured
    await ctx.app.inject({
      method: "POST",
      url: "/v1/me/device-tokens",
      headers: { authorization: `Bearer ${teacherAToken}` },
      payload: { token: "fcm-unconfigured-token-teacher-a-0002", platform: "android" },
    });
    const enqUnconf = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        category: "medication",
        recipient_user_ids: [ids.teacherA],
        title: "Unconfigured provider test",
        body: "In-app succeeds, push is not_configured",
        channels: ["in_app", "push"],
        idempotency_key: `fcm-unconf-${randomUUID()}`,
      },
    });
    const unconfOutboxId = enqUnconf.json().outbox_id as string;
    const fourth = await runCycle(workerPool, {
      workerName: "test-fcm-worker",
      leaseSeconds: 60,
      handlers: workerHandlers(mpesaProviderFromConfig(ctx.app.appConfig), { pushProvider: new NotConfiguredPushProvider() }),
    });
    expect(fourth).toBe("succeeded");
    const unconfDetail = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications/outbox/${unconfOutboxId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    const unconfAttempts = unconfDetail.json().attempts as Array<{ channel: string; status: string }>;
    expect(unconfAttempts.some((a) => a.channel === "push" && a.status === "not_configured")).toBe(true);
  });
});
