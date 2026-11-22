import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { InMemoryStorageProvider, setStorageProviderForTesting } from "../src/modules/storage/storageProvider.js";
import { MockPushProvider } from "../src/modules/notifications/pushProvider.js";
import { workerHandlers } from "../src/worker/handlers.js";
import { runCycle } from "../src/worker/runtime.js";
import { mpesaProviderFromConfig } from "../src/modules/finance/mpesaProvider.js";
import { createPool } from "../src/db/pool.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 5: Health and Medication Workflow (migration 092)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherAToken: string;
  let parentAToken: string;
  let teacherBToken: string;
  let learnerId: string;
  let workerPool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;

    const workerPassword = `wrk_${randomUUID().replace(/-/g, "")}`;
    await ctx.pool.query(`ALTER ROLE figbloom_worker WITH LOGIN PASSWORD '${workerPassword}'`);
    const workerUrl = new URL(process.env.MIGRATION_DATABASE_URL!);
    workerUrl.username = "figbloom_worker";
    workerUrl.password = workerPassword;
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2, applicationName: "figbloom-test-worker" });

    adminToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })
    ).json().token as string;
    teacherAToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD } })
    ).json().token as string;
    parentAToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD } })
    ).json().token as string;
    teacherBToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantB, loginId: "TC-0001", password: PASSWORD } })
    ).json().token as string;

    // Create active learner
    const l = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "Med Learner", admission_no: "MED-001", date_of_birth: "2015-03-15", gender: "male" },
    });
    expect(l.statusCode).toBe(201);
    learnerId = l.json().learner.id as string;

    // Create guardian record + link to learner + accepted invitation + guardian_accounts link
    const guardianId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO guardians (id, tenant_id, full_name, phone) VALUES ($1, $2, 'Parent A', '+254700000111')`,
      [guardianId, ids.tenantA],
    );
    await ctx.pool.query(
      `INSERT INTO guardian_links (tenant_id, learner_id, guardian_id, relationship) VALUES ($1, $2, $3, 'mother')`,
      [ids.tenantA, learnerId, guardianId],
    );
    const inv = (
      await ctx.pool.query(
        `INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, status,
            contact_verification, created_at, expires_at, accepted_at, accepted_by)
         VALUES ($1,$2,$3,'email','p@example.com',$4,'accepted','token_and_contact_echo', now() - interval '1 hour', now() + interval '1 day', now(), $5)
         RETURNING id`,
        [ids.tenantA, guardianId, learnerId, createHash("sha256").update(randomUUID()).digest("hex"), ids.parentA],
      )
    ).rows[0].id as string;
    await ctx.pool.query(
      `INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1, $2, $3, $4)`,
      [ids.tenantA, guardianId, ids.parentA, inv],
    );
  }, 120_000);

  afterEach(() => {
    setStorageProviderForTesting(null);
  });

  afterAll(async () => {
    setStorageProviderForTesting(null);
    if (workerPool) await workerPool.end();
    if (ctx) {
      await ctx.app.close();
      await ctx.pool.end();
    }
  });

  it("enforces full medication lifecycle: health profile, S3 doc, explicit guardian consent, approval, schedule, immutable MAR + corrections, incidents, central notifications & least privilege", async () => {
    const mockStorage = new InMemoryStorageProvider();
    setStorageProviderForTesting(mockStorage);

    // 1. Least privilege: ordinary teacher cannot read/write health profile or medication records (403)
    const teacherDenied = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/learners/${learnerId}/profile`,
      headers: { authorization: `Bearer ${teacherAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(teacherDenied.statusCode).toBe(403);

    // Cross-tenant denied (403)
    const crossDenied = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/learners/${learnerId}/profile`,
      headers: { authorization: `Bearer ${teacherBToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(crossDenied.statusCode).toBe(403);

    // 2. Authorized health staff/admin creates learner health profile
    const profRes = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/health/learners/${learnerId}/profile`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        blood_group: "O+",
        allergies: ["peanuts"],
        chronic_conditions: ["mild_asthma"],
        emergency_notes: "Inhaler kept at sick bay",
      },
    });
    expect(profRes.statusCode, JSON.stringify(profRes.json())).toBe(200);
    expect(profRes.json().profile.allergies).toEqual(["peanuts"]);

    // 3. Upload supporting authorization document via S3 storage
    const docInit = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        owner_resource_type: "medication_authorization",
        original_filename: "rx-auth.pdf",
        content_type: "application/pdf",
        byte_size: 20,
      },
    });
    expect(docInit.statusCode).toBe(201);
    const docId = docInit.json().object.id as string;

    // 4. Submit medication authorization (starts pending_consent)
    const authRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/authorizations`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        learner_id: learnerId,
        medication_name: "Salbutamol Inhaler",
        dosage_instruction: "2 puffs as directed by physician",
        frequency_instruction: "Once daily at 10:00",
        route: "inhaled",
        start_date: "2026-11-22",
        end_date: "2026-12-31",
        supporting_document_id: docId,
      },
    });
    expect(authRes.statusCode, JSON.stringify(authRes.json())).toBe(201);
    const authorizationId = authRes.json().authorization.id as string;
    expect(authRes.json().authorization.status).toBe("pending_consent");
    expect(authRes.json().authorization.guardian_consent_status).toBe("pending");

    // 5. Attempting to approve BEFORE guardian consent MUST fail (409)
    const prematureApprove = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/authorizations/${authorizationId}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { decision: "approved" },
    });
    expect(prematureApprove.statusCode).toBe(409);

    // 6. Attempting to create schedule for unapproved authorization MUST fail (409)
    const prematureSched = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/schedules`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { authorization_id: authorizationId, schedule_times: ["10:00"], window_minutes: 30 },
    });
    expect(prematureSched.statusCode).toBe(409);

    // 7. Linked guardian explicitly grants consent
    const consentRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/authorizations/${authorizationId}/consent`,
      headers: { authorization: `Bearer ${parentAToken}`, "x-tenant-id": ids.tenantA },
      payload: { decision: "granted", note: "I authorize school nurse administration" },
    });
    expect(consentRes.statusCode, JSON.stringify(consentRes.json())).toBe(200);
    expect(consentRes.json().authorization.guardian_consent_status).toBe("granted");

    // 8. Admin approves authorization
    const approveRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/authorizations/${authorizationId}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { decision: "approved" },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().authorization.status).toBe("approved");

    // 9. Create schedule
    const schedRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/schedules`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { authorization_id: authorizationId, schedule_times: ["10:00"], window_minutes: 30 },
    });
    expect(schedRes.statusCode).toBe(201);
    const scheduleId = schedRes.json().schedule.id as string;

    // 10. Record MAR administration (and verify idempotency on duplicate slot)
    const slotTime = "2026-11-22T07:00:00.000Z";
    const mar1 = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/administrations`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { schedule_id: scheduleId, scheduled_for: slotTime, outcome: "administered", notes: "Given on time" },
    });
    expect(mar1.statusCode).toBe(201);
    expect(mar1.json().replayed).toBe(false);
    const marId = mar1.json().record.id as string;

    const marReplay = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/administrations`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { schedule_id: scheduleId, scheduled_for: slotTime, outcome: "administered" },
    });
    expect(marReplay.statusCode).toBe(200);
    expect(marReplay.json().replayed).toBe(true);
    expect(marReplay.json().record.id).toBe(marId);

    // 11. Record missed administration (requires exception_reason) & auditable correction
    const marMissed = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/administrations`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        schedule_id: scheduleId,
        scheduled_for: "2026-11-23T07:00:00.000Z",
        outcome: "missed",
        exception_reason: "Learner absent from school",
      },
    });
    expect(marMissed.statusCode).toBe(201);

    const corrRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/administrations/${marId}/corrections`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { corrected_outcome: "delayed", correction_reason: "Logged 15 minutes after scheduled window" },
    });
    expect(corrRes.statusCode).toBe(201);

    // 12. Verify MAR history + corrections preserved
    const history = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/learners/${learnerId}/medications/mar`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().records).toHaveLength(2);
    expect(history.json().corrections).toHaveLength(1);

    // 13. Report medication incident
    const incRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/medications/incidents`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        learner_id: learnerId,
        authorization_id: authorizationId,
        mar_id: marId,
        severity: "medium",
        summary: "Learner reported mild dizziness after inhaler",
      },
    });
    expect(incRes.statusCode).toBe(201);

    // 14. Process central notification outbox jobs -> parentA receives privacy-safe notifications (NO drug name leaked!)
    const handlers = workerHandlers(mpesaProviderFromConfig(ctx.app.appConfig), { pushProvider: new MockPushProvider() });
    for (let i = 0; i < 6; i++) {
      const outcome = await runCycle(workerPool, { workerName: "test-med-worker", leaseSeconds: 60, handlers });
      if (outcome === "idle") break;
    }

    const parentNotifs = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/notifications?category=medication`,
      headers: { authorization: `Bearer ${parentAToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(parentNotifs.statusCode).toBe(200);
    const items = parentNotifs.json().notifications as Array<{ title: string; body: string }>;
    expect(items.length).toBeGreaterThanOrEqual(4); // submitted, approved, missed, incident
    // Privacy check: medication name "Salbutamol" must NEVER appear in notification titles or bodies
    expect(JSON.stringify(items)).not.toContain("Salbutamol");
  });
});
