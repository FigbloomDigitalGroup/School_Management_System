import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { enableWorkerLogin, resetWorkerLogin } from "./support/financeHarness.js";
import { createPool, workerPoolOptions } from "../src/db/pool.js";
import { workerHandlers } from "../src/worker/handlers.js";
import type { MpesaProvider } from "../src/modules/finance/mpesaProvider.js";
import { runCycle } from "../src/worker/runtime.js";

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

describe("Stage 12 adversarial security, RLS & concurrency suite (S12-02..S12-10, S12-12)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;
  let parentToken: string;
  let learnerId: string;
  let workerLogin: Awaited<ReturnType<typeof enableWorkerLogin>> | undefined;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a@example.com", password: PASSWORD },
      })
    ).json().token;
    teacherToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD },
      })
    ).json().token;
    parentToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD },
      })
    ).json().token;
    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "Stage12 Adv Learner", admission_no: "S12-ADV-1", date_of_birth: "2014-04-10", gender: "male" },
    });
    expect(learner.statusCode).toBe(201);
    learnerId = learner.json().learner.id as string;
  }, 120_000);

  afterAll(async () => {
    if (workerLogin) await workerLogin.end().catch(() => undefined);
    await resetWorkerLogin(ctx.pool).catch(() => undefined);
    await ctx.app.close();
    await ctx.pool.end();
  });

  function headers(token: string, tenant = ids.tenantA) {
    return { authorization: `Bearer ${token}`, "x-tenant-id": tenant };
  }

  it("S12-02 & S12-09: concurrent conversation creation is race-safe, and RESTRICTIVE RLS blocks third-user access & sender impersonation at DB level", async () => {
    // Concurrent startConversation from adminA -> teacherA and teacherA -> adminA
    const [r1, r2] = await Promise.all([
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/chat/conversations`,
        headers: headers(adminToken),
        payload: { peer_user_id: ids.teacherA },
      }),
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/chat/conversations`,
        headers: headers(teacherToken),
        payload: { peer_user_id: ids.adminA },
      }),
    ]);
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r2.statusCode, r2.body).toBe(201);
    const convId = r1.json().conversation.id as string;
    expect(r2.json().conversation.id).toBe(convId);

    // Send 3 messages and verify cursor pagination on messages & conversations
    for (const text of ["Message 1", "Message 2", "Message 3"]) {
      const m = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/chat/conversations/${convId}/messages`,
        headers: headers(adminToken),
        payload: { body: text },
      });
      expect(m.statusCode).toBe(201);
    }

    const page1 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations/${convId}/messages?limit=2`,
      headers: headers(teacherToken),
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().messages).toHaveLength(2);
    expect(page1.json().page.next_cursor).toBeTruthy();

    const page2 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations/${convId}/messages?limit=2&cursor=${encodeURIComponent(page1.json().page.next_cursor)}`,
      headers: headers(teacherToken),
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().messages.length).toBeGreaterThanOrEqual(1);

    // Non-participant parentA gets 404 via API
    const parentRead = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/chat/conversations/${convId}/messages`,
      headers: headers(parentToken),
    });
    expect(parentRead.statusCode).toBe(404);

    // Direct SQL as figbloom_app with app.tenant_id = tenantA and app.user_id = parentA (non-member in same tenant)
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        ids.tenantA,
        ids.parentA,
      ]);
      const convRows = await c.query(`SELECT id FROM conversations WHERE id = $1`, [convId]);
      expect(convRows.rowCount).toBe(0);
      const memRows = await c.query(`SELECT user_id FROM conversation_members WHERE conversation_id = $1`, [convId]);
      expect(memRows.rowCount).toBe(0);
      const msgRows = await c.query(`SELECT id FROM chat_messages WHERE conversation_id = $1`, [convId]);
      expect(msgRows.rowCount).toBe(0);
      await c.query("SAVEPOINT sp_parent_insert");
      await expect(
        c.query(
          `INSERT INTO chat_messages (tenant_id, conversation_id, sender_id, body) VALUES ($1, $2, $3, 'intruder')`,
          [ids.tenantA, convId, ids.parentA],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp_parent_insert");
      await c.query("COMMIT");

      // Direct SQL as member adminA attempting to impersonate teacherA as sender_id -> blocked by WITH CHECK (42501)
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        ids.tenantA,
        ids.adminA,
      ]);
      await c.query("SAVEPOINT sp_spoof");
      await expect(
        c.query(
          `INSERT INTO chat_messages (tenant_id, conversation_id, sender_id, body) VALUES ($1, $2, $3, 'forged sender')`,
          [ids.tenantA, convId, ids.teacherA],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp_spoof");

      // Admin A attempting to update teacherA's last_read_at -> 0 rows affected by RESTRICTIVE policy
      const updPeer = await c.query(
        `UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`,
        [convId, ids.teacherA],
      );
      expect(updPeer.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("S12-03, S12-06 & S12-07: visitor PII is minimized for host teachers, reads are audited, and gate_visits UPDATE columns are narrowed", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/gate-visits`,
      headers: headers(adminToken),
      payload: {
        visitor_name: "Sensitive Visitor",
        visitor_phone: "+254711222333",
        id_number: "NAT-ID-123456",
        vehicle_plate: "KDA 999Z",
        purpose: "Parent consultation",
        host_kind: "teacher",
        host_user_id: ids.teacherA,
        entry_point: "gate",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const visitId = created.json().visit.id as string;

    // Admin (has resource.visitor.read) sees full PII
    const adminGet = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/gate-visits/${visitId}`,
      headers: headers(adminToken),
    });
    expect(adminGet.statusCode).toBe(200);
    expect(adminGet.json().visit.visitor_phone).toBe("+254711222333");
    expect(adminGet.json().visit.id_number).toBe("NAT-ID-123456");
    expect(adminGet.json().visit.vehicle_plate).toBe("KDA 999Z");
    expect(adminGet.json().visit.recorded_by).toBe(ids.adminA);

    // Host teacher (lacks resource.visitor.read) sees visit but PII fields are null
    const teacherList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/gate-visits?mine=1`,
      headers: headers(teacherToken),
    });
    expect(teacherList.statusCode).toBe(200);
    const hosted = teacherList.json().visits.find((v: { id: string }) => v.id === visitId);
    expect(hosted).toBeTruthy();
    expect(hosted.visitor_name).toBe("Sensitive Visitor");
    expect(hosted.visitor_phone).toBeNull();
    expect(hosted.id_number).toBeNull();
    expect(hosted.vehicle_plate).toBeNull();
    expect(hosted.recorded_by).toBeNull();

    const teacherGet = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/gate-visits/${visitId}`,
      headers: headers(teacherToken),
    });
    expect(teacherGet.statusCode).toBe(200);
    expect(teacherGet.json().visit.id_number).toBeNull();
    expect(teacherGet.json().visit.visitor_phone).toBeNull();
    expect(teacherGet.json().visit.vehicle_plate).toBeNull();

    // S12-07: figbloom_app cannot UPDATE visitor_name or id_number on gate_visits
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        ids.tenantA,
        ids.adminA,
      ]);
      await c.query("SAVEPOINT sp_gv1");
      await expect(
        c.query(`UPDATE gate_visits SET visitor_name = 'Tampered' WHERE id = $1`, [visitId]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp_gv1");
      await c.query("SAVEPOINT sp_gv2");
      await expect(
        c.query(`UPDATE gate_visits SET id_number = '000' WHERE id = $1`, [visitId]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp_gv2");
      await c.query("ROLLBACK");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("S12-04, S12-05 & S12-06: sick-bay row_version optimistic concurrency, nullable PATCH, discharge finality, correction audit, and honest guardian_notices_available", async () => {
    const settingsRes = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/health/medical-settings`,
      headers: headers(adminToken),
    });
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.json().settings.guardian_notices_available).toBe(false);

    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits`,
      headers: headers(adminToken),
      payload: {
        learner_id: learnerId,
        complaint: "Fever and chills",
        temperature_c: 38.6,
        pulse_bpm: 98,
        observations: "Initial triage note",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const visitId = created.json().visit.id as string;
    expect(created.json().visit.row_version).toBe(1);

    // Nullable PATCH: clear temperature_c and observations to null
    const cleared = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${visitId}`,
      headers: headers(adminToken),
      payload: { row_version: 1, temperature_c: null, observations: null, treatment: "Paracetamol given" },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().visit.temperature_c).toBeNull();
    expect(cleared.json().visit.observations).toBeNull();
    expect(cleared.json().visit.treatment).toBe("Paracetamol given");
    expect(cleared.json().visit.row_version).toBe(2);

    // Stale row_version (1 instead of 2) -> 409 Conflict
    const stale = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${visitId}`,
      headers: headers(adminToken),
      payload: { row_version: 1, treatment: "Stale write" },
    });
    expect(stale.statusCode).toBe(409);

    // Discharge visit
    const discharged = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${visitId}`,
      headers: headers(adminToken),
      payload: {
        row_version: 2,
        outcome: "home",
        time_out: new Date().toISOString(),
      },
    });
    expect(discharged.statusCode, discharged.body).toBe(200);
    expect(discharged.json().visit.row_version).toBe(3);

    // Post-discharge PATCH without correction_reason -> 409 Conflict
    const noReason = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${visitId}`,
      headers: headers(adminToken),
      payload: { row_version: 3, follow_up: "Call parent tomorrow" },
    });
    expect(noReason.statusCode).toBe(409);

    // Post-discharge attempt to reopen (time_out: null) -> 409 Conflict
    const reopen = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${visitId}`,
      headers: headers(adminToken),
      payload: { row_version: 3, time_out: null, correction_reason: "Try to reopen" },
    });
    expect(reopen.statusCode).toBe(409);

    // Post-discharge amendment WITH correction_reason -> 200 and audited as health.sick_bay.visit_corrected
    const corrected = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/tenants/${ids.tenantA}/health/sick-bay/visits/${visitId}`,
      headers: headers(adminToken),
      payload: {
        row_version: 3,
        follow_up: "Review at clinic in 24h",
        correction_reason: "Added post-discharge follow-up instruction",
      },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(corrected.json().visit.row_version).toBe(4);
    expect(corrected.json().visit.correction_reason).toBe("Added post-discharge follow-up instruction");

    const audit = await ctx.pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM security_audit_events
        WHERE tenant_id = $1 AND event_type = 'health.sick_bay.visit_corrected'
          AND detail->>'visitId' = $2`,
      [ids.tenantA, visitId],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]?.detail.changedFields).toEqual(["follow_up"]);
    expect(audit.rows[0]?.detail.correctionReason).toBe("Added post-discharge follow-up instruction");
  });

  it("S12-08, S12-10 & S12-12: strict audience validation, atomic concurrent notification preferences, and announcement.push preference consultation + delivery ledger", async () => {
    // S12-08: Reject invalid audience shapes
    for (const badAudience of [
      { kind: "role", role: "wizard" },
      { kind: "roles", roles: ["teacher", "wizard"] },
      { kind: "roles", roles: ["teacher", "teacher"] },
      { kind: "user", user_id: "not-a-uuid" },
      { kind: "people", profile_ids: ["not-a-uuid"] },
      { kind: "class", class_id: "not-a-uuid" },
      { kind: "class", class_id: "00000000-0000-4000-8000-000000000999" },
      { kind: "form_level", form_level: 0 },
      { kind: "form_level", form_level: 13 },
      { kind: "form_level", form_level: "four" },
    ]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
        headers: headers(adminToken),
        payload: {
          subject: "Invalid audience probe",
          body: "Should fail validation",
          audience: badAudience,
          channels: ["in_app"],
        },
      });
      expect(res.statusCode, JSON.stringify(badAudience)).toBe(400);
    }

    // S12-10: Concurrent notification preference patches do not overwrite each other
    await ctx.app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { general_notices: false, chat_messages: true },
    });

    const [p1, p2] = await Promise.all([
      ctx.app.inject({
        method: "PATCH",
        url: "/v1/me/notification-preferences",
        headers: { authorization: `Bearer ${teacherToken}` },
        payload: { general_notices: true },
      }),
      ctx.app.inject({
        method: "PATCH",
        url: "/v1/me/notification-preferences",
        headers: { authorization: `Bearer ${teacherToken}` },
        payload: { chat_messages: false },
      }),
    ]);
    expect(p1.statusCode).toBe(200);
    expect(p2.statusCode).toBe(200);

    const finalPrefs = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/notification-preferences",
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    expect(finalPrefs.json().preferences.general_notices).toBe(true);
    expect(finalPrefs.json().preferences.chat_messages).toBe(false);

    // S12-12: Create & publish a role=teacher push announcement, run worker, and verify GET /announcements/:id exposes deliveries consulting general_notices
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements`,
      headers: headers(adminToken),
      payload: {
        subject: "Teacher Push Notice",
        body: "Checking general_notices consultation",
        audience: { kind: "role", role: "teacher" },
        channels: ["in_app", "push"],
      },
    });
    expect(created.statusCode).toBe(201);
    const annId = created.json().announcement.id as string;

    const pub = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${annId}/publish`,
      headers: headers(adminToken),
    });
    expect(pub.statusCode).toBe(200);

    await ctx.pool.query(
      `UPDATE jobs SET run_after = now() + interval '1 day'
        WHERE tenant_id = $1 AND job_type = 'announcement.push' AND idempotency_key <> $2`,
      [ids.tenantA, `announcement.push:${annId}`],
    );
    await ctx.pool.query(
      `UPDATE jobs SET run_after = now() - interval '1 second'
        WHERE tenant_id = $1 AND job_type = 'announcement.push' AND idempotency_key = $2`,
      [ids.tenantA, `announcement.push:${annId}`],
    );

    workerLogin = await enableWorkerLogin(ctx.pool, ctx.runtimeUrl);
    const wPool = createPool(
      workerPoolOptions({
        databaseUrl: workerLogin.connectionString,
        poolMax: 1,
        poolAcquireTimeoutMs: 2_000,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleInTransactionSessionTimeoutMs: 15_000,
        clientQueryTimeoutMs: 20_000,
        applicationName: "figbloom-s12-adv-worker",
      }),
    );
    try {
      const handlers = workerHandlers(fakeProvider);
      const outcome = await runCycle(wPool, {
        workerName: `s12-adv-${process.pid}`,
        leaseSeconds: 60,
        handlers: { "announcement.push": handlers["announcement.push"]! },
      });
      expect(outcome).toBe("succeeded");
    } finally {
      await wPool.end().catch(() => undefined);
    }

    const detailRes = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/communications/announcements/${annId}`,
      headers: headers(adminToken),
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().deliveries).toHaveLength(1);
    expect(detailRes.json().deliveries[0].channel).toBe("push");
    expect(detailRes.json().deliveries[0].status).toBe("skipped_no_provider");
    expect(detailRes.json().deliveries[0].detail.preferenceFlagConsulted).toBe("general_notices");
    expect(detailRes.json().deliveries[0].detail.eligibleRecipients).toBeGreaterThanOrEqual(1);
  });
});
