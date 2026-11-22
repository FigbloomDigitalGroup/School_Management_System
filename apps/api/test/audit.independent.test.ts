import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import {
  InMemoryStorageProvider,
  S3StorageProvider,
  setStorageProviderForTesting,
  type StorageDeleteResult,
} from "../src/modules/storage/storageProvider.js";
import { setBloomAiProviderForTesting } from "../src/modules/ai/bloomProvider.js";
import { buildXlsx, parseZipEntries, sanitizeSpreadsheetText, stripIllegalXmlChars } from "../src/modules/reporting/ooxml.js";
import { csvCell } from "../src/modules/reporting/exportFormat.js";

// Regression tests for the defects found by the independent audit of migrations 089-094 (fixed in 095 + source).
const PASSWORD = "correct-horse-battery";

describe("independent audit: pure units (SigV4, presign binding, XML/CSV hygiene)", () => {
  it("S3 SigV4 header signing reproduces the AWS documentation test vector (GET with Range)", () => {
    const p = new S3StorageProvider({
      bucket: "examplebucket",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      endpoint: "https://s3.amazonaws.com",
      forcePathStyle: false,
    });
    const out = (p as unknown as {
      signHeaders: (m: string, k: string, h: string, e: Record<string, string>, n: Date) => { url: string; headers: Record<string, string> };
    }).signHeaders(
      "GET",
      "test.txt",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      { range: "bytes=0-9" },
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(out.url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
    expect(out.headers.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
    expect(out.headers.authorization).toContain("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("a presigned PUT binds content-type and content-length into the signature (cannot be changed by the client)", async () => {
    const p = new S3StorageProvider({ bucket: "b", region: "eu-west-1", accessKeyId: "AK", secretAccessKey: "SK" });
    const r = await p.createPresignedUpload({ tenantId: "t", objectKey: "tenants/t/general/o", contentType: "application/pdf", maxBytes: 1234 });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    const q = new URL(r.url).searchParams;
    expect(q.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(r.requiredHeaders).toEqual({ "content-type": "application/pdf", "content-length": "1234" });
    // changing a bound header value changes the signature
    const r2 = await p.createPresignedUpload({ tenantId: "t", objectKey: "tenants/t/general/o", contentType: "text/html", maxBytes: 1234 });
    if (r2.status !== "ready") return;
    expect(new URL(r2.url).searchParams.get("X-Amz-Signature")).not.toBe(q.get("X-Amz-Signature"));
  });

  it("XML-illegal characters are stripped before the formula check and from the produced XLSX", () => {
    expect(stripIllegalXmlChars("a\u0001b￾￿c\ud800d")).toBe("abcd");
    expect(sanitizeSpreadsheetText("\u0001=1+1")).toBe("'=1+1");
    expect(csvCell("\u0001=cmd|' /C calc'!A0")).toMatch(/^'=/);
    const xlsx = buildXlsx({ sheetName: "t", title: "t", headers: ["h"], rows: [["￾=HYPERLINK(\"x\")￿", "ok\ud800"]] });
    const sheet = parseZipEntries(xlsx).get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(sheet).not.toMatch(/[￾￿\ud800]/);
    expect(sheet).toContain("&apos;=HYPERLINK");
  });
});

describe("independent audit: medication, storage and AI (database-backed)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let parentToken: string;
  let learnerId: string;
  let otherLearnerId: string;
  let authorizationId: string;
  let scheduleId: string;
  const H = (t: string) => ({ authorization: `Bearer ${t}`, "x-tenant-id": ids?.tenantA });

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })).json().token as string;
    parentToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD } })
    ).json().token as string;
    const mk = async (name: string, adm: string) => {
      const r = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/learners`,
        headers: H(adminToken),
        payload: { full_name: name, admission_no: adm, date_of_birth: "2015-03-15", gender: "male" },
      });
      expect(r.statusCode).toBe(201);
      return r.json().learner.id as string;
    };
    learnerId = await mk("Audit Learner", "AUD-001");
    otherLearnerId = await mk("Audit Other", "AUD-002");

    const guardianId = randomUUID();
    await ctx.pool.query(`INSERT INTO guardians (id, tenant_id, full_name, phone) VALUES ($1,$2,'Audit Parent','+254700000222')`, [guardianId, ids.tenantA]);
    await ctx.pool.query(`INSERT INTO guardian_links (tenant_id, learner_id, guardian_id, relationship) VALUES ($1,$2,$3,'mother')`, [ids.tenantA, learnerId, guardianId]);
    const inv = (
      await ctx.pool.query(
        `INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, status,
            contact_verification, created_at, expires_at, accepted_at, accepted_by)
         VALUES ($1,$2,$3,'email','aud@example.com',$4,'accepted','token_and_contact_echo', now() - interval '1 hour', now() + interval '1 day', now(), $5) RETURNING id`,
        [ids.tenantA, guardianId, learnerId, createHash("sha256").update(randomUUID()).digest("hex"), ids.parentA],
      )
    ).rows[0].id as string;
    await ctx.pool.query(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1,$2,$3,$4)`, [ids.tenantA, guardianId, ids.parentA, inv]);
    await ctx.pool.query(`INSERT INTO finance_ai_helper_settings (tenant_id, access_mode) VALUES ($1,'all') ON CONFLICT DO NOTHING`, [ids.tenantA]);
  }, 120_000);

  afterEach(() => {
    setStorageProviderForTesting(null);
    setBloomAiProviderForTesting(null);
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const post = (url: string, token: string, payload: unknown) => ctx.app.inject({ method: "POST", url: `/v1/tenants/${ids.tenantA}${url}`, headers: H(token), payload: payload as object });

  it("medication: slot, date range, consent revocation and cross-learner links are enforced (API and database)", async () => {
    const a = await post("/health/medications/authorizations", adminToken, {
      learner_id: learnerId, medication_name: "Synthetic Med", dosage_instruction: "as written by guardian", frequency_instruction: "daily 10:00",
      start_date: "2026-11-22", end_date: "2026-12-31",
    });
    expect(a.statusCode, a.body).toBe(201);
    authorizationId = a.json().authorization.id;
    expect((await post(`/health/medications/authorizations/${authorizationId}/consent`, parentToken, { decision: "granted" })).statusCode).toBe(200);
    expect((await post(`/health/medications/authorizations/${authorizationId}/review`, adminToken, { decision: "approved" })).statusCode).toBe(200);
    // an already-reviewed authorization cannot be reviewed again
    expect((await post(`/health/medications/authorizations/${authorizationId}/review`, adminToken, { decision: "rejected", reason: "changed my mind" })).statusCode).toBe(409);

    const s = await post("/health/medications/schedules", adminToken, { authorization_id: authorizationId, schedule_times: ["10:00"], window_minutes: 30 });
    expect(s.statusCode, s.body).toBe(201);
    scheduleId = s.json().schedule.id;

    const mar = (scheduled_for: string, outcome = "administered") =>
      post("/health/medications/administrations", adminToken, { schedule_id: scheduleId, scheduled_for, outcome, ...(outcome === "administered" ? {} : { exception_reason: "synthetic reason" }) });

    // the same dose under a slightly different timestamp must NOT be accepted as a second dose
    for (const bad of ["2026-11-24T07:01:00.000Z", "2026-11-24T07:00:30.000Z", "2026-11-24T06:30:00.000Z"]) {
      const r = await mar(bad);
      expect(r.statusCode, `${bad}: ${r.body}`).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
    }
    // outside the authorization's own dates
    expect((await mar("2027-01-05T07:00:00.000Z")).statusCode).toBeGreaterThanOrEqual(400);
    // the exact slot works once and replays idempotently
    expect((await mar("2026-11-24T07:00:00.000Z")).statusCode).toBe(201);
    expect((await mar("2026-11-24T07:00:00.000Z")).statusCode).toBe(200);

    // incident cannot link another learner's authorization
    const inc = await post("/health/medications/incidents", adminToken, { learner_id: otherLearnerId, authorization_id: authorizationId, severity: "low", summary: "cross link attempt" });
    expect(inc.statusCode).toBeGreaterThanOrEqual(400);
    expect(inc.statusCode).toBeLessThan(500);

    // the guardian revokes consent: schedules stop, administered doses are refused (API and raw database insert)
    expect((await post(`/health/medications/authorizations/${authorizationId}/consent`, parentToken, { decision: "revoked" })).statusCode).toBe(200);
    const sched = await ctx.pool.query(`SELECT active, cancelled_at FROM medication_schedules WHERE id = $1`, [scheduleId]);
    expect(sched.rows[0].active).toBe(false);
    expect(sched.rows[0].cancelled_at).not.toBeNull();
    expect((await mar("2026-11-25T07:00:00.000Z")).statusCode).toBe(409);
    await expect(
      ctx.pool.query(
        `INSERT INTO medication_administration_records (tenant_id, schedule_id, authorization_id, learner_id, scheduled_for, administered_at, outcome)
         VALUES ($1,$2,$3,$4,'2026-11-26T07:00:00Z', now(), 'administered')`,
        [ids.tenantA, scheduleId, authorizationId, learnerId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // mismatched learner on a raw insert is refused by the guard too
    await expect(
      ctx.pool.query(
        `INSERT INTO medication_administration_records (tenant_id, schedule_id, authorization_id, learner_id, scheduled_for, outcome, exception_reason)
         VALUES ($1,$2,$3,$4,'2026-11-27T07:00:00Z', 'held', 'synthetic')`,
        [ids.tenantA, scheduleId, authorizationId, otherLearnerId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("storage: size/type are bound at completion, a mismatching object is discarded, finalize is single-shot, failed S3 delete is not hidden", async () => {
    class FailingDelete extends InMemoryStorageProvider {
      failDelete = false;
      override async deleteObject(req: { tenantId: string; objectKey: string }): Promise<StorageDeleteResult> {
        if (this.failDelete) return { status: "error", code: "s3_delete_500" };
        return super.deleteObject(req);
      }
    }
    const mem = new FailingDelete();
    setStorageProviderForTesting(mem);
    const init = async (size: number) => {
      const r = await post("/storage/objects", adminToken, { owner_resource_type: "general", original_filename: "a.pdf", content_type: "application/pdf", byte_size: size });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().object as { id: string };
    };
    const keyOf = async (id: string) => (await ctx.pool.query(`SELECT object_key FROM storage_objects WHERE id = $1`, [id])).rows[0].object_key as string;

    // wrong size uploaded -> completion refused, bytes removed, row failed
    const o1 = await init(20);
    await mem.putObject({ tenantId: ids.tenantA, objectKey: await keyOf(o1.id), contentType: "application/pdf", body: Buffer.alloc(5) });
    expect((await post(`/storage/objects/${o1.id}/complete`, adminToken, {})).statusCode).toBe(409);
    expect((await ctx.pool.query(`SELECT status FROM storage_objects WHERE id = $1`, [o1.id])).rows[0].status).toBe("failed");
    expect(mem.store.has(await keyOf(o1.id))).toBe(false);

    // wrong content type uploaded -> refused
    const o2 = await init(20);
    await mem.putObject({ tenantId: ids.tenantA, objectKey: await keyOf(o2.id), contentType: "text/html", body: Buffer.alloc(20) });
    expect((await post(`/storage/objects/${o2.id}/complete`, adminToken, {})).statusCode).toBe(409);

    // correct upload completes once; completing again (content swap window) is refused
    const o3 = await init(20);
    await mem.putObject({ tenantId: ids.tenantA, objectKey: await keyOf(o3.id), contentType: "application/pdf", body: Buffer.alloc(20) });
    expect((await post(`/storage/objects/${o3.id}/complete`, adminToken, {})).statusCode).toBe(200);
    expect((await post(`/storage/objects/${o3.id}/complete`, adminToken, {})).statusCode).toBe(409);

    // a failing S3 delete must not mark the object deleted
    mem.failDelete = true;
    const del = await ctx.app.inject({ method: "DELETE", url: `/v1/tenants/${ids.tenantA}/storage/objects/${o3.id}`, headers: H(adminToken) });
    expect(del.statusCode).toBe(409);
    expect((await ctx.pool.query(`SELECT status FROM storage_objects WHERE id = $1`, [o3.id])).rows[0].status).toBe("available");
    mem.failDelete = false;
    expect((await ctx.app.inject({ method: "DELETE", url: `/v1/tenants/${ids.tenantA}/storage/objects/${o3.id}`, headers: H(adminToken) })).statusCode).toBe(204);
  });

  it("bloom ai: no database row lock on the shared rate buckets is held while the provider call is in flight", async () => {
    await ctx.pool.query(`DELETE FROM auth_rate_buckets WHERE bucket_key LIKE 'bloom:%'`);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inProvider = new Promise<void>((r) => (entered = r));
    setBloomAiProviderForTesting({
      configured: true,
      async generate(req) {
        entered();
        await gate;
        return { status: "ok", scope: req.requestedScope, answer: "ok", provider: "test", request_id: "r1" };
      },
    });
    const pending = ctx.app.inject({ method: "POST", url: `/v1/tenants/${ids.tenantA}/ai/query`, headers: H(adminToken), payload: { scope: "school", prompt: "hello" } });
    await inProvider;
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      // would raise 55P03 if the provider-bound request still held the row lock
      const locked = await client.query(`SELECT bucket_key FROM auth_rate_buckets WHERE bucket_key LIKE 'bloom:%' FOR UPDATE NOWAIT`);
      expect(locked.rows.length).toBeGreaterThanOrEqual(3);
      await client.query("ROLLBACK");
    } finally {
      client.release();
      release();
    }
    expect((await pending).statusCode).toBe(200);
  });
});
