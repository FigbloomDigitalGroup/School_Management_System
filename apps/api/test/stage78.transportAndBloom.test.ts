import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { buildApp } from "../src/app.js";
import { MockPushProvider } from "../src/modules/notifications/pushProvider.js";
import { workerHandlers } from "../src/worker/handlers.js";
import { runCycle } from "../src/worker/runtime.js";
import { mpesaProviderFromConfig } from "../src/modules/finance/mpesaProvider.js";
import { setBloomAiProviderForTesting } from "../src/modules/ai/bloomProvider.js";
import { createPool } from "../src/db/pool.js";

const PASSWORD = "correct-horse-battery";

describe("Stages 7 & 8: Transport Incident Lifecycle + Central Notifications & Bloom AI Hardening (migration 094)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let appInstance2: Awaited<ReturnType<typeof buildApp>>;
  let ids: FixtureIds;
  let workerPool: ReturnType<typeof createPool>;
  let adminToken: string;
  let driverToken: string;
  let parentToken: string;
  let teacherToken: string;
  let driverId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    // Second Fastify instance sharing the same DB pool to prove multi-instance shared rate limiting
    appInstance2 = await buildApp(ctx.app.appConfig, ctx.pool);

    const workerPassword = `wrk_${randomUUID().replace(/-/g, "")}`;
    await ctx.pool.query(`ALTER ROLE figbloom_worker WITH LOGIN PASSWORD '${workerPassword}'`);
    const workerUrl = new URL(process.env.MIGRATION_DATABASE_URL!);
    workerUrl.username = "figbloom_worker";
    workerUrl.password = workerPassword;
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2, applicationName: "figbloom-test-worker" });

    adminToken = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })).json().token;
    parentToken = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD } })).json().token;
    teacherToken = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD } })).json().token;

    driverId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, 'drv-s7@example.com', password_hash, 'Driver S7', 'active' FROM users WHERE id = $2`,
      [driverId, ids.adminA],
    );
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'driver', 'DR-7701')`,
      [driverId, ids.tenantA],
    );
    driverToken = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "drv-s7@example.com", password: PASSWORD } })).json().token;

    // Enable Bloom AI for tenantA
    await ctx.pool.query(`INSERT INTO finance_ai_helper_settings (tenant_id, access_mode) VALUES ($1, 'all') ON CONFLICT DO NOTHING`, [ids.tenantA]);
  }, 120_000);

  afterAll(async () => {
    setBloomAiProviderForTesting(null);
    if (appInstance2) await appInstance2.close();
    if (workerPool) await workerPool.end();
    if (ctx) {
      await ctx.app.close();
      await ctx.pool.end();
    }
  });

  it("Stage 7: bridges transport events into central notification engine, supports read-state & incident acknowledge/escalate/resolve", async () => {
    const T = ids.tenantA;
    const call = (tok: string, method: "GET" | "POST" | "PUT", path: string, payload?: unknown) =>
      ctx.app.inject({
        method,
        url: `/v1/tenants/${T}${path}`,
        headers: { authorization: `Bearer ${tok}`, "x-tenant-id": T },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });

    // Setup vehicle, route, learner, guardian link, assignment
    const v = (await call(adminToken, "POST", "/vehicles", { plate_number: "KDA 700A", capacity: 30 })).json().vehicle.id as string;
    const r = (await call(adminToken, "POST", "/transport-routes", { name: "Route S7" })).json().route.id as string;
    const l = (await call(adminToken, "POST", "/learners", { full_name: "Rider S7", admission_no: "S7-001", date_of_birth: "2015-01-01", gender: "female" })).json().learner.id as string;
    const lt = await call(adminToken, "PUT", "/learner-transport", { learner_id: l, route_id: r });
    expect(lt.statusCode).toBe(200);
    const asg = await call(adminToken, "POST", `/vehicles/${v}/assignments`, { driver_user_id: driverId, route_id: r });
    expect(asg.statusCode).toBe(204);

    const gId = randomUUID();
    await ctx.pool.query(`INSERT INTO guardians (id, tenant_id, full_name, phone) VALUES ($1, $2, 'Parent S7', '+254700000777')`, [gId, T]);
    await ctx.pool.query(`INSERT INTO guardian_links (tenant_id, learner_id, guardian_id, relationship) VALUES ($1, $2, $3, 'father')`, [T, l, gId]);
    const inv = (
      await ctx.pool.query(
        `INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, status,
            contact_verification, created_at, expires_at, accepted_at, accepted_by)
         VALUES ($1,$2,$3,'email','p7@example.com',$4,'accepted','token_and_contact_echo', now() - interval '1 hour', now() + interval '1 day', now(), $5)
         RETURNING id`,
        [T, gId, l, createHash("sha256").update(randomUUID()).digest("hex"), ids.parentA],
      )
    ).rows[0].id as string;
    await ctx.pool.query(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1, $2, $3, $4)`, [T, gId, ids.parentA, inv]);

    // Driver starts trip -> notifies guardian via both transport_notifications and central notification_outbox
    const tripRes = await call(driverToken, "POST", "/driver/trips", { vehicle_id: v, direction: "to_school" });
    expect(tripRes.statusCode).toBe(201);
    const tripId = tripRes.json().trip.id as string;

    // Guardian reads transport notification & marks it read
    const tnList = await call(parentToken, "GET", "/me/transport/notifications");
    expect(tnList.statusCode).toBe(200);
    expect(tnList.json().notifications.length).toBeGreaterThanOrEqual(1);
    const tnId = tnList.json().notifications[0].id as string;

    const tnRead = await call(parentToken, "POST", `/me/transport/notifications/${tnId}/read`);
    expect(tnRead.statusCode).toBe(200);
    expect(tnRead.json().notification.in_app_read_at).toBeTruthy();

    // Driver logs an incident event -> auto-creates transport_incidents record
    const incEv = await call(driverToken, "POST", `/trips/${tripId}/events`, {
      event_type: "incident",
      note: "Flat tyre near junction",
    });
    expect(incEv.statusCode).toBe(201);

    const incList = await call(adminToken, "GET", `/trips/${tripId}/incidents`);
    expect(incList.statusCode).toBe(200);
    expect(incList.json().incidents).toHaveLength(1);
    const incidentId = incList.json().incidents[0].id as string;
    expect(incList.json().incidents[0].status).toBe("open");

    // Driver cannot acknowledge/escalate/resolve (403)
    const drvAck = await call(driverToken, "POST", `/trips/${tripId}/incidents/${incidentId}/acknowledge`, {});
    expect(drvAck.statusCode).toBe(403);

    // Admin acknowledges -> escalates with notify_guardians: true -> resolves
    const ack = await call(adminToken, "POST", `/trips/${tripId}/incidents/${incidentId}/acknowledge`, { severity: "medium" });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().incident.status).toBe("acknowledged");

    const esc = await call(adminToken, "POST", `/trips/${tripId}/incidents/${incidentId}/escalate`, {
      reason: "Replacement bus dispatched",
      severity: "high",
      notify_guardians: true,
    });
    expect(esc.statusCode).toBe(200);
    expect(esc.json().incident.status).toBe("escalated");
    expect(esc.json().guardians_notified).toBe(true);

    const resv = await call(adminToken, "POST", `/trips/${tripId}/incidents/${incidentId}/resolve`, {
      resolution_note: "All learners transferred safely to replacement bus",
    });
    expect(resv.statusCode).toBe(200);
    expect(resv.json().incident.status).toBe("resolved");

    // Process central notification engine jobs -> parentA receives transport notifications in central inbox
    const handlers = workerHandlers(mpesaProviderFromConfig(ctx.app.appConfig), { pushProvider: new MockPushProvider() });
    for (let i = 0; i < 6; i++) {
      const outcome = await runCycle(workerPool, { workerName: "test-tr-worker", leaseSeconds: 60, handlers });
      if (outcome === "idle") break;
    }
    const centralNotifs = await call(parentToken, "GET", "/notifications?category=transport");
    expect(centralNotifs.statusCode).toBe(200);
    expect(centralNotifs.json().notifications.length).toBeGreaterThanOrEqual(2); // trip_started + incident_escalated
  });

  it("Stage 8: enforces Bloom AI role eligibility policy and shared PG rate limiting across multiple API instances", async () => {
    setBloomAiProviderForTesting({
      configured: true,
      async generate(req) {
        return { status: "ok", scope: req.requestedScope, answer: "Mock answer", provider: "mock", request_id: req.requestId ?? "r-1" };
      },
    });

    const ask = (appInst: typeof ctx.app, tok: string, scope: string) =>
      appInst.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/ai/query`,
        headers: { authorization: `Bearer ${tok}`, "x-tenant-id": ids.tenantA },
        payload: { scope, prompt: "Hello Bloom" },
      });

    // 1. Driver is NOT eligible for Bloom AI (403)
    const drvRes = await ask(ctx.app, driverToken, "public");
    expect(drvRes.statusCode).toBe(403);

    // 2. Parent gets 'public' ONLY; 'school' and 'internal_figbloom' are refused (403)
    const parPub = await ask(ctx.app, parentToken, "public");
    expect(parPub.statusCode).toBe(200);
    const parSchool = await ask(ctx.app, parentToken, "school");
    expect(parSchool.statusCode).toBe(403);
    const parInternal = await ask(ctx.app, parentToken, "internal_figbloom");
    expect(parInternal.statusCode).toBe(403);

    // 3. Teacher gets 'school', refused 'internal_figbloom'
    const tchSchool = await ask(ctx.app, teacherToken, "school");
    expect(tchSchool.statusCode).toBe(200);
    const tchInternal = await ask(ctx.app, teacherToken, "internal_figbloom");
    expect(tchInternal.statusCode).toBe(403);

    // 4. Shared PG rate limit across TWO separate Fastify instances: 20 requests total for teacherToken
    // (1 already used above; send 10 on instance 1, 9 on instance 2 -> 21st on instance 2 MUST return 429!)
    for (let i = 0; i < 10; i++) {
      expect((await ask(ctx.app, teacherToken, "public")).statusCode).toBe(200);
    }
    for (let i = 0; i < 9; i++) {
      expect((await ask(appInstance2, teacherToken, "public")).statusCode).toBe(200);
    }
    const overLimit = await ask(appInstance2, teacherToken, "public");
    expect(overLimit.statusCode).toBe(429);
    expect(overLimit.headers["retry-after"]).toBeTruthy();
  });
});
