import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMPORT_PREVIEW_BODY_LIMIT } from "../src/http/routes/imports.js";
import { MAX_IMPORT_ROWS } from "../src/modules/imports/learnersCsv.js";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 16 learner CSV import adversarial & contract verification (S16-1..S16-11, OA-2)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;
  let parentToken: string;
  let adminBToken: string;
  let secondAdminAId: string;
  let secondAdminAToken: string;

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
    adminBToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: ids.tenantB, loginId: "TC-0001", password: PASSWORD },
      })
    ).json().token;

    // Seed a second school_admin in tenantA to verify S16-11 importer ownership (created_by === actorUserId).
    const hashRow = await ctx.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [ids.adminA],
    );
    const u2 = await ctx.pool.query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, status)
       VALUES ('admin-a2@example.com', 'Second Admin A', $1, 'active')
       RETURNING id`,
      [hashRow.rows[0]!.password_hash],
    );
    secondAdminAId = u2.rows[0]!.id;
    await ctx.pool.query(
      `INSERT INTO school_memberships (tenant_id, user_id, role, login_id)
       VALUES ($1, $2, 'school_admin', 'AD-0002')`,
      [ids.tenantA, secondAdminAId],
    );
    secondAdminAToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a2@example.com", password: PASSWORD },
      })
    ).json().token;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const authHeaders = (token = adminToken, tenantId = ids.tenantA) => ({
    authorization: `Bearer ${token}`,
    "x-tenant-id": tenantId,
  });

  it("S16-1: preview detects active AND archived learner admission_no conflicts (case/trim-insensitive) while remaining tenant-scoped", async () => {
    // Create active learner and archived learner in tenantA, plus archived learner in tenantB
    const createActive = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: authHeaders(),
      payload: { admission_no: "S161-ACT", full_name: "Active Learner", gender: "female" },
    });
    expect(createActive.statusCode).toBe(201);

    const createArch = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: authHeaders(),
      payload: { admission_no: "S161-ARCH", full_name: "Archived Learner", gender: "male" },
    });
    expect(createArch.statusCode).toBe(201);
    const archId = createArch.json().learner.id as string;
    const archRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners/${archId}/archive`,
      headers: authHeaders(),
    });
    expect(archRes.statusCode).toBe(200);

    await ctx.pool.query(
      `INSERT INTO learners (tenant_id, admission_no, full_name, gender, active, archived_at)
       VALUES ($1, 'S161-FOREIGN-ARCH', 'Tenant B Archived', 'female', false, now())`,
      [ids.tenantB],
    );

    const csv = [
      "admission_no,full_name,gender",
      " s161-act ,Duplicate Active,female",
      " s161-arch ,Duplicate Archived,male",
      "S161-FOREIGN-ARCH,Allowed In Tenant A,female",
    ].join("\n");

    const preview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(),
      payload: { csv },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const body = preview.json().preview;
    expect(body.row_count).toBe(3);
    expect(body.valid_count).toBe(1);
    expect(body.error_count).toBe(2);
    expect(body.errors.map((e: { line: number }) => e.line)).toEqual([2, 3]);
    expect(body.errors[1].message).toMatch(/archived/i);
    expect(body.sample_valid[0].admission_no).toBe("S161-FOREIGN-ARCH");

    // Archived learner restore flow remains intact
    const restoreRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners/${archId}/restore`,
      headers: authHeaders(),
    });
    expect(restoreRes.statusCode).toBe(200);
  });

  it("S16-2 & S16-6: shared validation parity between POST /learners and CSV preview/apply (calendar dates, future DOB, boarding, formula injection, lengths)", async () => {
    // Parameterized parity checks between direct POST /learners and CSV preview
    const invalidCases = [
      { admission_no: "S162-1", full_name: "Bad Feb 31", gender: "female", date_of_birth: "2026-02-31", boarding: "false" },
      { admission_no: "S162-2", full_name: "Non Leap Feb 29", gender: "male", date_of_birth: "2025-02-29", boarding: "false" },
      { admission_no: "S162-3", full_name: "Century Non Leap", gender: "female", date_of_birth: "1900-02-29", boarding: "false" },
      { admission_no: "S162-4", full_name: "April 31", gender: "male", date_of_birth: "2025-04-31", boarding: "false" },
      { admission_no: "S162-5", full_name: "Future DOB", gender: "female", date_of_birth: "2099-01-15", boarding: "false" },
      { admission_no: "=CMD()", full_name: "Formula Adm", gender: "male", date_of_birth: "2014-05-01", boarding: "false" },
      { admission_no: "S162-7", full_name: "=1+1", gender: "female", date_of_birth: "2014-05-01", boarding: "false" },
      { admission_no: "S162-8", full_name: "+SUM(A1:A2)", gender: "male", date_of_birth: "2014-05-01", boarding: "false" },
      { admission_no: "S162-9", full_name: "-2+3", gender: "female", date_of_birth: "2014-05-01", boarding: "false" },
      { admission_no: "S162-10", full_name: "@IMPORTXML()", gender: "male", date_of_birth: "2014-05-01", boarding: "false" },
      { admission_no: "S162-11", full_name: " \t=CMD()", gender: "female", date_of_birth: "2014-05-01", boarding: "false" },
      { admission_no: "X".repeat(33), full_name: "Too Long Adm", gender: "male", date_of_birth: "2014-05-01", boarding: "false" },
      { admission_no: "S162-13", full_name: "N".repeat(121), gender: "female", date_of_birth: "2014-05-01", boarding: "false" },
    ];

    for (const c of invalidCases) {
      const direct = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/learners`,
        headers: authHeaders(),
        payload: {
          admission_no: c.admission_no,
          full_name: c.full_name,
          gender: c.gender,
          date_of_birth: c.date_of_birth,
          boarding: false,
        },
      });
      expect(direct.statusCode, `direct POST /learners for ${JSON.stringify(c)}`).toBe(400);
    }

    const csvRows = [
      "admission_no,full_name,gender,date_of_birth,boarding",
      ...invalidCases.map((c) => `"${c.admission_no}","${c.full_name}",${c.gender},${c.date_of_birth},${c.boarding}`),
      "S162-BAD-BOARD,Bad Boarding,female,2014-05-01,maybe",
      "S162-LEAP-OK,Anne-Marie O'Connor,FEMALE,2024-02-29,yes",
    ].join("\n");

    const preview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(),
      payload: { csv: csvRows },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const p = preview.json().preview;
    expect(p.valid_count).toBe(1);
    expect(p.error_count).toBe(invalidCases.length + 1);
    expect(p.sample_valid[0]).toMatchObject({
      admission_no: "S162-LEAP-OK",
      full_name: "Anne-Marie O'Connor",
      gender: "female",
      date_of_birth: "2024-02-29",
      boarding: true,
    });

    // Apply single valid row with hyphen/apostrophe name and verify stored verbatim without corruption
    const validOnly = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(),
      payload: {
        csv: "admission_no,full_name,gender,date_of_birth,boarding\nS166-SAFE,Anne-Marie O'Connor,female,2024-02-29,yes",
      },
    });
    expect(validOnly.statusCode).toBe(200);
    const applySafe = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers: authHeaders(),
      payload: { import_id: validOnly.json().preview.import_id },
    });
    expect(applySafe.statusCode, applySafe.body).toBe(200);
    const stored = await ctx.pool.query<{ full_name: string; admission_no: string }>(
      `SELECT admission_no, full_name FROM learners WHERE tenant_id = $1 AND admission_no = 'S166-SAFE'`,
      [ids.tenantA],
    );
    expect(stored.rows[0]).toEqual({ admission_no: "S166-SAFE", full_name: "Anne-Marie O'Connor" });
  });

  it("S16-5, S16-7 & S16-8: RFC 4180 parsing (BOM, quoted commas/newlines/escaped quotes, blank-line physical line numbers, ragged rows, headers, truncation flag)", async () => {
    // 1) Quoted comma, quoted multiline cell, escaped quotes, UTF-8 BOM, blank line before invalid row
    const rfcCsv =
      "\uFEFFadmission_no,full_name,gender,date_of_birth,boarding\r\n" +
      'RFC-01,"Doe, Jane",female,2014-05-01,false\r\n' +
      'RFC-02,"Mwangi ""J""\r\nWanjiku",male,2013-08-10,true\r\n' +
      "\r\n" +
      "RFC-BAD,Invalid After Multiline And Blank,unknown_gender,2014-01-01,false\r\n" +
      "RFC-RAGGED,Only Two Cols\r\n" +
      "RFC-EXTRA,Extra Trailing Comma,female,2014-01-01,false,\r\n";

    const preview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(),
      payload: { csv: rfcCsv },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const p = preview.json().preview;
    expect(p.valid_count).toBe(2);
    expect(p.error_count).toBe(3);
    expect(p.sample_valid[0].full_name).toBe("Doe, Jane");
    expect(p.sample_valid[1].full_name).toBe('Mwangi "J"\nWanjiku');
    // Line 1: header, Line 2: RFC-01, Lines 3-4: RFC-02 (multiline), Line 5: blank, Line 6: RFC-BAD, Line 7: RFC-RAGGED, Line 8: RFC-EXTRA
    expect(p.errors.map((e: { line: number }) => e.line)).toEqual([6, 7, 8]);

    // 2) Malformed CSV syntax and header rejections (400)
    const malformedPayloads = [
      'admission_no,full_name,gender\nA1,"Unclosed quote,female',
      'admission_no,full_name,gender\nA1,Stray"Quote,female',
      'admission_no,full_name,gender\nA1,"Trailing"Text,female',
      "admission_no,full_name,gender,admission_no\nA1,Dup Header,female,A1",
      "admission_no,full_name,gender,unknown_col\nA1,Unknown Header,female,x",
      "admission_no,full_name,gender,class\nA1,Class Column Rejected,female,Grade 5A",
      "admission_no,full_name\nA1,Missing Gender",
      "admission_no,full_name,gender\nA1,Null\0Byte,female",
    ];
    for (const badCsv of malformedPayloads) {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
        headers: authHeaders(),
        payload: { csv: badCsv },
      });
      expect(res.statusCode, `malformed CSV: ${badCsv}`).toBe(400);
    }

    // 3) S16-8: errors_truncated flag when > 100 invalid rows exist
    const manyErrorsCsv = [
      "admission_no,full_name,gender",
      ...Array.from({ length: 105 }, (_, i) => `ERR-${i},,bad_gender`),
    ].join("\n");
    const truncRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(),
      payload: { csv: manyErrorsCsv },
    });
    expect(truncRes.statusCode).toBe(200);
    expect(truncRes.json().preview.error_count).toBe(105);
    expect(truncRes.json().preview.errors).toHaveLength(100);
    expect(truncRes.json().preview.errors_truncated).toBe(true);
  });

  it("OA-2 & S16-4: route-level bodyLimit accepts >64 KiB CSV up to 1 MB while global 64 KiB limit and MAX_IMPORT_ROWS hold", async () => {
    // 1) > 64 KiB CSV (~95 KiB, 900 rows) succeeds on /imports/learners/preview
    const padding = "P".repeat(80);
    const largeValidCsv = [
      "admission_no,full_name,gender,date_of_birth,boarding",
      ...Array.from({ length: 900 }, (_, i) => `LRG-${i},${padding} ${i},female,2014-03-15,false`),
    ].join("\n");
    expect(Buffer.byteLength(largeValidCsv, "utf8")).toBeGreaterThan(75 * 1024);

    const largeRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(),
      payload: { csv: largeValidCsv },
    });
    expect(largeRes.statusCode, largeRes.body).toBe(200);
    expect(largeRes.json().preview.valid_count).toBe(900);

    // 2) Exceeding route-level bodyLimit (> 1.5 MiB) returns HTTP 413
    const hugePayload = JSON.stringify({ csv: "A".repeat(IMPORT_PREVIEW_BODY_LIMIT + 2048) });
    const tooLargePreview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: hugePayload,
    });
    expect(tooLargePreview.statusCode).toBe(413);

    // 3) Global 64 KiB bodyLimit remains enforced on other endpoints (/v1/auth/login/email and /imports/learners/apply)
    const over64K = JSON.stringify({ import_id: "x".repeat(70 * 1024) });
    const applyTooLarge = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: over64K,
    });
    expect(applyTooLarge.statusCode).toBe(413);

    // 4) S16-4: Exceeding MAX_IMPORT_ROWS (1,001 rows within small byte size) returns 400
    const tooManyRowsCsv = [
      "admission_no,full_name,gender",
      ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `R-${i},Learner ${i},male`),
    ].join("\n");
    const rowCapRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(),
      payload: { csv: tooManyRowsCsv },
    });
    expect(rowCapRes.statusCode).toBe(400);
    expect(rowCapRes.json().error.message).toMatch(/maximum row limit/i);
  });

  it("S16-3, S16-9, S16-10 & S16-11: apply revalidation rollback, importer ownership, concurrent idempotent replay, PII redaction, and audit enrichment", async () => {
    // 1) Atomic rollback when a conflicting learner is created between preview and apply
    const raceCsv = [
      "admission_no,full_name,gender",
      "RACE-01,Race Learner One,female",
      "RACE-02,Race Learner Two,male",
    ].join("\n");
    const racePreview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(),
      payload: { csv: raceCsv },
    });
    expect(racePreview.statusCode).toBe(200);
    const raceImportId = racePreview.json().preview.import_id as string;

    // Create RACE-02 directly before applying batch
    const raceDirect = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: authHeaders(),
      payload: { admission_no: "RACE-02", full_name: "Direct Conflict", gender: "male" },
    });
    expect(raceDirect.statusCode).toBe(201);

    const raceApply = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers: authHeaders(),
      payload: { import_id: raceImportId },
    });
    expect(raceApply.statusCode).toBe(409);
    expect(raceApply.json().error.message).toMatch(/line 3/i);
    // Atomic rollback: RACE-01 was NOT created
    const race01Check = await ctx.pool.query(
      `SELECT 1 FROM learners WHERE tenant_id = $1 AND admission_no = 'RACE-01'`,
      [ids.tenantA],
    );
    expect(race01Check.rowCount).toBe(0);

    // 2) S16-11: Importer ownership + RBAC + cross-tenant checks
    const ownCsv = [
      "admission_no,full_name,gender,date_of_birth",
      "OWN-01,Confidential Learner One,female,2014-04-10",
      "OWN-02,Confidential Learner Two,male,2013-09-20",
    ].join("\n");
    const ownPreview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(adminToken),
      payload: { csv: ownCsv },
    });
    expect(ownPreview.statusCode).toBe(200);
    const ownImportId = ownPreview.json().preview.import_id as string;

    // Unauthenticated -> 401
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
          payload: { import_id: ownImportId },
        })
      ).statusCode,
    ).toBe(401);
    // Teacher / Parent -> 403
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
          headers: authHeaders(teacherToken),
          payload: { import_id: ownImportId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
          headers: authHeaders(parentToken),
          payload: { import_id: ownImportId },
        })
      ).statusCode,
    ).toBe(403);
    // Cross-tenant -> 403/404
    expect([403, 404]).toContain(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/v1/tenants/${ids.tenantB}/imports/learners/apply`,
          headers: authHeaders(adminBToken, ids.tenantB),
          payload: { import_id: ownImportId },
        })
      ).statusCode,
    );
    // Second school_admin in SAME tenant who did NOT create the preview -> 403 (S16-11)
    const wrongOwnerApply = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers: authHeaders(secondAdminAToken),
      payload: { import_id: ownImportId },
    });
    expect(wrongOwnerApply.statusCode, wrongOwnerApply.body).toBe(403);

    // 3) S16-3: Concurrent apply by the legitimate owner serializes cleanly with 0 duplicates
    const [apply1, apply2] = await Promise.all([
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
        headers: authHeaders(adminToken),
        payload: { import_id: ownImportId },
      }),
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
        headers: authHeaders(adminToken),
        payload: { import_id: ownImportId },
      }),
    ]);
    expect(apply1.statusCode, apply1.body).toBe(200);
    expect(apply2.statusCode, apply2.body).toBe(200);
    expect([apply1.json().result.replayed, apply2.json().result.replayed].sort()).toEqual([false, true]);
    const ownCreated = await ctx.pool.query(
      `SELECT admission_no FROM learners WHERE tenant_id = $1 AND admission_no IN ('OWN-01', 'OWN-02')`,
      [ids.tenantA],
    );
    expect(ownCreated.rowCount).toBe(2);

    // 4) S16-9: preview_json PII is redacted after apply while preserving sha256 and counts
    const batchRow = await ctx.pool.query<{
      status: string;
      row_count: number;
      created_count: number;
      payload_sha256: string;
      preview_json: Record<string, unknown>;
    }>(
      `SELECT status, row_count, created_count, payload_sha256, preview_json FROM import_batches WHERE id = $1`,
      [ownImportId],
    );
    expect(batchRow.rows[0]!.status).toBe("applied");
    expect(batchRow.rows[0]!.created_count).toBe(2);
    expect(batchRow.rows[0]!.payload_sha256).toHaveLength(64);
    expect(batchRow.rows[0]!.preview_json.redacted).toBe(true);
    expect(JSON.stringify(batchRow.rows[0]!.preview_json)).not.toContain("Confidential Learner");

    // 5) S16-10: Audit events contain ip, payloadSha256, rowCount, validCount, errorCount, createdCount
    const previewAudit = await ctx.pool.query<{ ip: string | null; detail: Record<string, unknown> }>(
      `SELECT ip::text, detail FROM security_audit_events
        WHERE tenant_id = $1 AND event_type = 'import.learners.previewed' AND detail->>'importId' = $2`,
      [ids.tenantA, ownImportId],
    );
    expect(previewAudit.rows[0]!.ip).not.toBeNull();
    expect(previewAudit.rows[0]!.detail).toMatchObject({
      importId: ownImportId,
      payloadSha256: batchRow.rows[0]!.payload_sha256,
      rowCount: 2,
      validCount: 2,
      errorCount: 0,
    });

    const applyAudit = await ctx.pool.query<{ ip: string | null; detail: Record<string, unknown> }>(
      `SELECT ip::text, detail FROM security_audit_events
        WHERE tenant_id = $1 AND event_type = 'import.learners.applied' AND detail->>'importId' = $2`,
      [ids.tenantA, ownImportId],
    );
    expect(applyAudit.rows).toHaveLength(1);
    expect(applyAudit.rows[0]!.ip).not.toBeNull();
    expect(applyAudit.rows[0]!.detail).toMatchObject({
      importId: ownImportId,
      payloadSha256: batchRow.rows[0]!.payload_sha256,
      rowCount: 2,
      createdCount: 2,
    });

    // 6) Cancelled batch returns 409 on apply; unknown UUID returns 404
    const cancelPreview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/preview`,
      headers: authHeaders(adminToken),
      payload: { csv: "admission_no,full_name,gender\nCANC-01,Cancel Test,female" },
    });
    const cancelId = cancelPreview.json().preview.import_id as string;
    await ctx.pool.query(`UPDATE import_batches SET status = 'cancelled' WHERE id = $1`, [cancelId]);
    const cancelledApply = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers: authHeaders(adminToken),
      payload: { import_id: cancelId },
    });
    expect(cancelledApply.statusCode).toBe(409);

    const missingApply = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/imports/learners/apply`,
      headers: authHeaders(adminToken),
      payload: { import_id: randomUUID() },
    });
    expect(missingApply.statusCode).toBe(404);
  });
});
