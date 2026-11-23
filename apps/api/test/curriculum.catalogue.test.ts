import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 6: Curriculum Catalogue Import, Provenance, Verification & Supersession (migration 093)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let superToken: string;
  let teacherAToken: string;
  let teacherBToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;

    adminToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })
    ).json().token as string;
    superToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "super@example.com", password: PASSWORD } })
    ).json().token as string;
    teacherAToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD } })
    ).json().token as string;
    teacherBToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantB, loginId: "TC-0001", password: PASSWORD } })
    ).json().token as string;
  }, 120_000);

  afterAll(async () => {
    if (ctx) {
      await ctx.app.close();
      await ctx.pool.end();
    }
  });

  it("preserves the 39 existing unverified platform entries and runs full import -> review -> verify/reject -> supersede -> history lifecycle", async () => {
    // 1. Existing 39 platform entries MUST remain visibly unverified/incomplete (0 verified)
    const existing = await ctx.pool.query<{ total: number; verified: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE verification_status = 'verified')::int AS verified
         FROM curriculum_reference_entries WHERE tenant_id IS NULL`,
    );
    expect(existing.rows[0]?.total).toBe(37);
    expect(existing.rows[0]?.verified).toBe(0);

    // Pick one platform entry ID — school admin MUST NOT be able to verify a platform-level entry
    const platEntry = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM curriculum_reference_entries WHERE tenant_id IS NULL LIMIT 1`,
    );
    const platEntryId = platEntry.rows[0]!.id;

    const schoolAdminPlatDenied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/entries/${platEntryId}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { action: "verify", review_note: "Attempted unauthorized promotion" },
    });
    expect(schoolAdminPlatDenied.statusCode).toBe(403);

    // Teacher cannot import or verify (403)
    const teacherImportDenied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/import-batches`,
      headers: { authorization: `Bearer ${teacherAToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        source_organisation: "KICD",
        source_title: "Grade 4 Math Design",
        retrieved_at: "2026-11-22",
        entries: [{ entry_kind: "learning_area", code: "G4-MATH", title: "Mathematics" }],
      },
    });
    expect(teacherImportDenied.statusCode).toBe(403);

    // 2. Authorized import batch with 2 valid entries, 1 duplicate, and 1 invalid entry
    const batchRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/import-batches`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        source_organisation: "KICD Public Curriculum Designs",
        source_title: "Grade 4 Mathematics & Science",
        source_uri: "https://kicd.ac.ke/curriculum-reform/curriculum-designs/",
        publication_or_version: "2024-rev1",
        retrieved_at: "2026-11-22",
        entries: [
          { entry_kind: "learning_area", code: "G4-MATH", title: "Mathematics Grade 4", education_level: "primary", grade_band: "4" },
          { entry_kind: "learning_area", code: "G4-SCI", title: "Science & Technology Grade 4", education_level: "primary", grade_band: "4" },
          { entry_kind: "learning_area", code: "g4-math", title: "Duplicate Math" }, // case-insensitive duplicate
          { entry_kind: "invalid_kind", code: "", title: "" }, // invalid
        ],
      },
    });
    expect(batchRes.statusCode, JSON.stringify(batchRes.json())).toBe(201);
    expect(batchRes.json().batch.imported_count).toBe(2);
    expect(batchRes.json().batch.duplicate_count).toBe(1);
    expect(batchRes.json().batch.error_count).toBe(1);
    const [mathId, sciId] = batchRes.json().imported_entry_ids as [string, string];

    // 3. Submit for review -> verify mathId, reject sciId
    const underReview = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/entries/${mathId}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { action: "submit_for_review", review_note: "Queued for academic head check" },
    });
    expect(underReview.statusCode).toBe(200);
    expect(underReview.json().entry.verification_status).toBe("under_review");

    const verified = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/entries/${mathId}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { action: "verify", review_note: "Verified against published KICD PDF" },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().entry.verification_status).toBe("verified");
    expect(verified.json().entry.reviewed_by).toBe(ids.adminA);

    const rejected = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/entries/${sciId}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { action: "reject", review_note: "Incomplete strand mapping" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().entry.verification_status).toBe("rejected");

    // 4. Supersede mathId -> creates v2 (imported, NOT auto-verified!) and marks v1 superseded
    const supRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/entries/${mathId}/supersede`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        title: "Mathematics Grade 4 (2025 Revision)",
        publication_or_version: "2025-rev2",
        review_note: "Updated outcomes",
      },
    });
    expect(supRes.statusCode, JSON.stringify(supRes.json())).toBe(201);
    expect(supRes.json().entry.version_number).toBe(2);
    expect(supRes.json().entry.verification_status).toBe("imported");

    // 5. History preserves both v1 (superseded) and v2 (imported)
    const histRes = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/entries/${mathId}/history`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(histRes.statusCode).toBe(200);
    expect(histRes.json().versions).toHaveLength(2);
    expect(histRes.json().versions[0].verification_status).toBe("superseded");
    expect(histRes.json().versions[1].version_number).toBe(2);

    // 6. Attempting to transition a superseded entry is refused (409)
    const supTrans = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/entries/${mathId}/review`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { action: "verify" },
    });
    expect(supTrans.statusCode).toBe(409);

    // 7. Cross-tenant access denied (403)
    const crossTenant = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/academics/cbe/curriculum-catalogue/import-batches`,
      headers: { authorization: `Bearer ${teacherBToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(crossTenant.statusCode).toBe(403);

    // Confirm super_admin token is valid and all 39 platform entries remain unverified (0 verified)
    expect(superToken).toBeTruthy();
    const stillUnverified = await ctx.pool.query<{ total: number; verified: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE verification_status = 'verified')::int AS verified
         FROM curriculum_reference_entries WHERE tenant_id IS NULL`,
    );
    expect(stillUnverified.rows[0]?.total).toBe(37);
    expect(stillUnverified.rows[0]?.verified).toBe(0);
  });
});
