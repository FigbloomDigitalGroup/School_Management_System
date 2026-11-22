import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { computeTotpCode } from "../src/modules/auth/mfa.js";
import { setBloomAiProviderForTesting } from "../src/modules/ai/bloomProvider.js";
import { setLiveKitProviderForTesting, NotConfiguredLiveKitProvider } from "../src/modules/communications/livekitProvider.js";
import { setStorageProviderForTesting, NotConfiguredStorageProvider } from "../src/modules/storage/storageProvider.js";

const PASSWORD = "correct-horse-battery";

describe("Antigravity Phase 4 authorized backend workstreams (WS-4..WS-8)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;

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
  }, 120_000);

  afterAll(async () => {
    setBloomAiProviderForTesting(null);
    setLiveKitProviderForTesting(new NotConfiguredLiveKitProvider());
    setStorageProviderForTesting(new NotConfiguredStorageProvider());
    await ctx.app.close();
    await ctx.pool.end();
  });

  function admin(method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) {
    return ctx.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": ids.tenantA,
        ...(payload ? { "idempotency-key": randomUUID() } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  it("WS-4 Transport GPS (N-08): ingests plausible pings, rejects teleport jumps, and prunes expired rows", async () => {
    const veh = await admin("POST", `/v1/tenants/${ids.tenantA}/vehicles`, {
      plate_number: "KDA-100A",
      capacity: 40,
    });
    expect(veh.statusCode).toBe(201);
    const vehicleId = veh.json().vehicle.id as string;

    const t1 = new Date(Date.now() - 120_000).toISOString();
    const p1 = await admin("POST", `/v1/tenants/${ids.tenantA}/vehicles/${vehicleId}/locations`, {
      lat: -1.2921,
      lng: 36.8219,
      speed_kmh: 45,
      recorded_at: t1,
    });
    expect(p1.statusCode).toBe(201);

    // 1000+ km jump in 60 seconds -> rejected
    const t2 = new Date(Date.now() - 60_000).toISOString();
    const bad = await admin("POST", `/v1/tenants/${ids.tenantA}/vehicles/${vehicleId}/locations`, {
      lat: 4.0435,
      lng: 39.6682,
      recorded_at: t2,
    });
    expect(bad.statusCode).toBe(400);

    const list = await admin("GET", `/v1/tenants/${ids.tenantA}/vehicles/${vehicleId}/locations`);
    expect(list.statusCode).toBe(200);
    expect(list.json().locations.length).toBe(1);

    // Expire the row and prune via worker_prune_vehicle_locations
    await ctx.pool.query(`UPDATE vehicle_locations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      p1.json().location.id,
    ]);
    await ctx.pool.query(`ALTER ROLE figbloom_worker WITH LOGIN PASSWORD 'worker-pass'`);
    const workerRes = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM vehicle_locations WHERE id = $1`,
      [p1.json().location.id],
    );
    expect(workerRes.rows[0]!.n).toBe(1);
    const { Pool } = await import("pg");
    const wPool = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL!.replace(/\/\/[^@]+@/, "//figbloom_worker:worker-pass@"),
    });
    try {
      const pruned = await wPool.query<{ n: number }>(`SELECT public.worker_prune_vehicle_locations(100) AS n`);
      expect(pruned.rows[0]!.n).toBeGreaterThanOrEqual(1);
    } finally {
      await wPool.end();
      await ctx.pool.query(`ALTER ROLE figbloom_worker WITH NOLOGIN`);
    }
  });

  it("WS-5 Attendance coverage: assigns, authorizes covering teacher for register, and cancels", async () => {
    const year = await admin("POST", `/v1/tenants/${ids.tenantA}/academic-years`, {
      label: "Cov Year",
      starts_on: "2020-01-01",
      ends_on: "2035-12-31",
    });
    const yearId = year.json().academic_year.id as string;
    const term = await admin("POST", `/v1/tenants/${ids.tenantA}/academic-terms`, {
      academic_year_id: yearId,
      index: 1,
      label: "T1",
      starts_on: "2020-01-01",
      ends_on: "2035-12-31",
    });
    const termId = term.json().term.id as string;
    const klass = await admin("POST", `/v1/tenants/${ids.tenantA}/classes`, {
      academic_year_id: yearId,
      name: "Cov 5A",
      form_level: 5,
    });
    const classId = klass.json().school_class.id as string;
    const learner = await admin("POST", `/v1/tenants/${ids.tenantA}/learners`, {
      admission_no: "COV-001",
      full_name: "Cov Learner",
      gender: "female",
    });
    const learnerId = learner.json().learner.id as string;
    await admin("POST", `/v1/tenants/${ids.tenantA}/class-memberships`, { learner_id: learnerId, class_id: classId });
    const staff = await admin("POST", `/v1/tenants/${ids.tenantA}/staff`, {
      full_name: "Covering Teacher",
      classification: "teacher",
      userId: ids.teacherA,
    });
    const staffId = staff.json().staff.id as string;

    const cov = await admin("POST", `/v1/tenants/${ids.tenantA}/attendance-coverage`, {
      class_id: classId,
      covering_staff_id: staffId,
      coverage_date: "2026-04-10",
      session: "morning",
      reason: "Class teacher on leave",
    });
    expect(cov.statusCode).toBe(201);
    const covId = cov.json().coverage.id as string;

    // Covering teacher can take morning register on 2026-04-10 even without a teaching assignment
    const reg = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/attendance-registers`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        learner_id: learnerId,
        class_id: classId,
        term_id: termId,
        taken_on: "2026-04-10",
        mark: "present",
      },
    });
    expect(reg.statusCode).toBe(200);

    const list = await admin("GET", `/v1/tenants/${ids.tenantA}/attendance-coverage?classId=${classId}`);
    expect(list.statusCode).toBe(200);
    expect(list.json().coverage.length).toBe(1);

    const cancel = await admin("POST", `/v1/tenants/${ids.tenantA}/attendance-coverage/${covId}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().coverage.status).toBe("cancelled");
  });

  it("WS-6 Academics & CBC depth: criteria sub-scores, timetable publish, KICD catalogue, online auto-mark, exports", async () => {
    const year = await admin("POST", `/v1/tenants/${ids.tenantA}/academic-years`, {
      label: "WS6 Year",
      starts_on: "2020-01-01",
      ends_on: "2035-12-31",
    });
    const yearId = year.json().academic_year.id as string;
    const term = await admin("POST", `/v1/tenants/${ids.tenantA}/academic-terms`, {
      academic_year_id: yearId,
      index: 1,
      label: "T1",
      starts_on: "2020-01-01",
      ends_on: "2035-12-31",
    });
    const termId = term.json().term.id as string;
    const klass = await admin("POST", `/v1/tenants/${ids.tenantA}/classes`, {
      academic_year_id: yearId,
      name: "WS6 Grade 6",
      form_level: 6,
      education_level: "primary",
    });
    const classId = klass.json().school_class.id as string;
    const subj = await admin("POST", `/v1/tenants/${ids.tenantA}/subjects`, { code: "SCI", name: "Science" });
    const subjectId = subj.json().subject.id as string;
    const learner = await admin("POST", `/v1/tenants/${ids.tenantA}/learners`, {
      admission_no: "WS6-001",
      full_name: "WS6 Learner",
      gender: "male",
    });
    const learnerId = learner.json().learner.id as string;
    await admin("POST", `/v1/tenants/${ids.tenantA}/class-memberships`, { learner_id: learnerId, class_id: classId });

    // KICD public learning areas
    const kicd = await admin("GET", `/v1/tenants/${ids.tenantA}/curriculum-reference?entryKind=learning_area`);
    expect(kicd.statusCode).toBe(200);
    expect(kicd.json().official_catalogue).toBe(false);
    expect(kicd.json().entries.length).toBeGreaterThanOrEqual(5);

    // Criterion-level rubric + CBE result
    const prov = await admin("POST", `/v1/tenants/${ids.tenantA}/curriculum-provenance`, {
      source_kind: "school_configured",
      source_label: "WS6 Pack",
    });
    const area = await admin("POST", `/v1/tenants/${ids.tenantA}/learning-areas`, {
      provenance_id: prov.json().provenance.id,
      code: "SCI",
      name: "Science & Tech",
    });
    const strand = await admin("POST", `/v1/tenants/${ids.tenantA}/strands`, {
      learning_area_id: area.json().learning_area.id,
      code: "MAT",
      name: "Matter",
    });
    const rubric = await admin("POST", `/v1/tenants/${ids.tenantA}/rubric-configs`, {
      name: "Multi-Criterion",
      scoring_mode: "numerical",
      descriptors: [
        { level_code: "EE", label: "Exceeding", points: 4 },
        { level_code: "ME", label: "Meeting", points: 3 },
      ],
      criteria: [
        { code: "accuracy", title: "Accuracy", max_points: 4 },
        { code: "clarity", title: "Clarity", max_points: 4 },
      ],
    });
    expect(rubric.statusCode).toBe(201);
    const cbe = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments`, {
      class_id: classId,
      learning_area_id: area.json().learning_area.id,
      term_id: termId,
      title: "Lab Practical",
      rubric_config_id: rubric.json().rubric_config.id,
      strand_id: strand.json().strand.id,
    });
    const res = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments/${cbe.json().cbe_assessment.id}/results`, {
      learner_id: learnerId,
      strand_id: strand.json().strand.id,
      level_code: "EE",
      points: 4,
      criterion_scores: [
        { criterion_code: "accuracy", level_code: "EE", points: 4 },
        { criterion_code: "clarity", level_code: "ME", points: 3 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().result.criterion_scores.length).toBe(2);

    // Timetable publication
    await admin("POST", `/v1/tenants/${ids.tenantA}/timetable-slots`, {
      class_id: classId,
      subject_id: subjectId,
      day_of_week: 2,
      starts_at: "10:00",
      ends_at: "11:00",
    });
    const pubDraft = await admin("POST", `/v1/tenants/${ids.tenantA}/timetable-publications`, {
      class_id: classId,
      term_id: termId,
    });
    expect(pubDraft.statusCode).toBe(201);
    expect(pubDraft.json().publication.status).toBe("draft");
    expect(pubDraft.json().publication.slots_snapshot.length).toBe(1);
    const published = await admin(
      "POST",
      `/v1/tenants/${ids.tenantA}/timetable-publications/${pubDraft.json().publication.id}/publish`,
    );
    expect(published.statusCode).toBe(200);
    expect(published.json().publication.status).toBe("published");

    // Online exam objective auto-marking
    const paper = await admin("POST", `/v1/tenants/${ids.tenantA}/online-exam-papers`, {
      class_id: classId,
      subject_id: subjectId,
      title: "Quiz 1",
      max_score: 10,
      questions: [
        { id: "q1", prompt: "2+2?", kind: "mcq", options: ["3", "4"], correct_answer: "4", points: 5 },
        { id: "q2", prompt: "Sky is blue?", kind: "true_false", correct_answer: "true", points: 5 },
      ],
    });
    expect(paper.statusCode).toBe(201);
    const attempt = await admin("POST", `/v1/tenants/${ids.tenantA}/online-exam-papers/${paper.json().paper.id}/attempts`, {
      learner_id: learnerId,
    });
    const submit = await admin(
      "POST",
      `/v1/tenants/${ids.tenantA}/online-exam-attempts/${attempt.json().attempt.id}/submit`,
      { answers: { q1: "4", q2: "false" } },
    );
    expect(submit.statusCode).toBe(200);
    expect(submit.json().attempt.auto_marked).toBe(true);
    expect(submit.json().attempt.mark.score).toBe("5");

    // Report card & analytics exports (JSON, CSV, PDF)
    const rc = await admin("POST", `/v1/tenants/${ids.tenantA}/report-cards`, { term_id: termId, class_id: classId });
    const rcId = rc.json().report_card.id as string;
    const rcCsv = await admin("GET", `/v1/tenants/${ids.tenantA}/report-cards/${rcId}/export?format=csv`);
    expect(rcCsv.statusCode).toBe(200);
    expect(rcCsv.headers["content-type"]).toContain("text/csv");
    const rcPdf = await admin("GET", `/v1/tenants/${ids.tenantA}/report-cards/${rcId}/export?format=pdf`);
    expect(rcPdf.statusCode).toBe(200);
    expect(rcPdf.headers["content-type"]).toContain("application/pdf");
    expect(rcPdf.rawPayload.toString("utf8", 0, 8)).toBe("%PDF-1.4");
    const repCsv = await admin("GET", `/v1/tenants/${ids.tenantA}/reports/export?kind=overview&format=csv`);
    expect(repCsv.statusCode).toBe(200);
    expect(repCsv.headers["content-type"]).toContain("text/csv");
  });

  it("WS-7 Provider-neutral interfaces: not_configured 503, Bloom AI knowledge boundary, and stubbed providers", async () => {
    const learner = await admin("POST", `/v1/tenants/${ids.tenantA}/learners`, {
      admission_no: "WS7-001",
      full_name: "WS7 Learner",
      gender: "female",
    });
    const doc = await admin("POST", `/v1/tenants/${ids.tenantA}/documents`, {
      subject_type: "learner",
      subject_id: learner.json().learner.id,
      doc_type: "birth_certificate",
      file_name: "cert.pdf",
    });
    expect(doc.statusCode).toBe(201);
    const docId = doc.json().document.id as string;

    const upNotConf = await admin("POST", `/v1/tenants/${ids.tenantA}/documents/${docId}/storage-presign`, {
      operation: "put",
    });
    expect(upNotConf.statusCode).toBe(503);
    expect(upNotConf.json().status).toBe("not_configured");

    setStorageProviderForTesting({
      configured: true,
      async createPresignedUpload() {
        return { status: "ready", url: "https://storage.example/upload", expiresInSeconds: 300 };
      },
      async createPresignedDownload() {
        return { status: "ready", url: "https://storage.example/download", expiresInSeconds: 300 };
      },
    });
    const upReady = await admin("POST", `/v1/tenants/${ids.tenantA}/documents/${docId}/storage-presign`, {
      operation: "put",
    });
    expect(upReady.statusCode).toBe(200);
    expect(upReady.json().status).toBe("ready");

    const lkNotConf = await admin("POST", `/v1/tenants/${ids.tenantA}/live-classes/token`, {
      room_name: "grade-4-math",
    });
    expect(lkNotConf.statusCode).toBe(503);
    expect(lkNotConf.json().status).toBe("not_configured");

    // Bloom AI: disabled by default -> 403
    const aiDisabled = await admin("POST", `/v1/tenants/${ids.tenantA}/ai/query`, {
      scope: "school",
      prompt: "Summarize attendance",
    });
    expect(aiDisabled.statusCode).toBe(403);

    // Enable AI helper settings for tenantA
    await ctx.pool.query(
      `INSERT INTO finance_ai_helper_settings (tenant_id, access_mode) VALUES ($1, 'all')
       ON CONFLICT (tenant_id) DO UPDATE SET access_mode = 'all'`,
      [ids.tenantA],
    );

    // School user cannot access internal_figbloom -> 403
    const aiBoundary = await admin("POST", `/v1/tenants/${ids.tenantA}/ai/query`, {
      scope: "internal_figbloom",
      prompt: "Show internal margins",
    });
    expect(aiBoundary.statusCode).toBe(403);

    // Unconfigured provider -> 503 not_configured
    const aiNotConf = await admin("POST", `/v1/tenants/${ids.tenantA}/ai/query`, {
      scope: "school",
      prompt: "Help with lesson plan",
    });
    expect(aiNotConf.statusCode).toBe(503);
    expect(aiNotConf.json().status).toBe("not_configured");

    // Stubbed provider -> 200 ok
    setBloomAiProviderForTesting({
      configured: true,
      async generate(req) {
        return { status: "ok", scope: req.requestedScope, answer: `Stub answer for ${req.tenantId}`, provider: "stub" };
      },
    });
    const aiOk = await admin("POST", `/v1/tenants/${ids.tenantA}/ai/query`, {
      scope: "public",
      prompt: "What is CBC?",
    });
    expect(aiOk.statusCode).toBe(200);
    expect(aiOk.json().status).toBe("ok");
  });

  it("WS-8 MFA (D-6): TOTP enrollment, verification, challenge, single-use recovery code, and disable", async () => {
    const enroll = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/totp/enroll",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(enroll.statusCode).toBe(200);
    const { secret, recoveryCodes } = enroll.json() as { secret: string; recoveryCodes: string[] };
    expect(recoveryCodes.length).toBe(8);

    // RFC 6238 single use: each accepted code must be a strictly newer time step (clock window is +/-1 step)
    const code = computeTotpCode(secret, Date.now(), -1);
    const verify = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/totp/verify",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().verified).toBe(true);

    const chalTotp = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/challenge",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { code: computeTotpCode(secret) },
    });
    expect(chalTotp.statusCode).toBe(200);
    expect(chalTotp.json().method).toBe("totp");

    // replay: the same code and the older verification code are refused
    for (const replay of [computeTotpCode(secret), code]) {
      const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/challenge", headers: { authorization: `Bearer ${adminToken}` }, payload: { code: replay } });
      expect(r.statusCode).toBe(401);
    }

    const chalRec = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/challenge",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { recovery_code: recoveryCodes[0] },
    });
    expect(chalRec.statusCode).toBe(200);
    expect(chalRec.json().method).toBe("recovery_code");

    // MFA attempts are throttled per user (burst 5, then 1/min, migration 088): start a new burst window for the rest of this flow
    await ctx.pool.query(`DELETE FROM auth_rate_buckets`);
    // Replaying the same single-use recovery code fails
    const replayRec = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/challenge",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { recovery_code: recoveryCodes[0] },
    });
    expect(replayRec.statusCode).toBe(401);

    const disable = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/disable",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { code: computeTotpCode(secret, Date.now(), 1) },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().disabled).toBe(true);
  });
});
