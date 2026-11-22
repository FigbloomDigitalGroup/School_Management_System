import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 14 reporting adversarial, permission split, semantic alignment & EXPLAIN index suite (S14-1..S14-7)", () => {
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
    await ctx.app.close();
    await ctx.pool.end();
  });

  function headers(token: string, tenant = ids.tenantA) {
    return { authorization: `Bearer ${token}`, "x-tenant-id": tenant };
  }

  it("S14-1: separates report reading (overview/attendance) from finance summary reading (resource.finance.read) — original title: general report reading (resource.report.read) from finance summary reading (resource.finance.read)", async () => {
    await ctx.pool.query(
      `INSERT INTO role_permissions (role, permission_code) VALUES ('teacher', 'resource.report.overview.read'), ('teacher', 'resource.report.attendance.read') ON CONFLICT DO NOTHING`,
    );
    try {
      const overview = await ctx.app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/reports/overview`,
        headers: headers(teacherToken),
      });
      expect(overview.statusCode).toBe(200);

      const attendance = await ctx.app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/reports/attendance-daily?date=2026-03-10`,
        headers: headers(teacherToken),
      });
      expect(attendance.statusCode).toBe(200);

      // Teacher WITHOUT resource.finance.read is denied on finance-summary -> 403
      const finDenied = await ctx.app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/reports/finance-summary`,
        headers: headers(teacherToken),
      });
      expect(finDenied.statusCode).toBe(403);
    } finally {
      await ctx.pool.query(
        `DELETE FROM role_permissions WHERE role = 'teacher' AND permission_code IN ('resource.report.overview.read', 'resource.report.attendance.read')`,
      );
    }

    // Grant teacherA area.fees (which implies resource.finance.read, not resource.report.read)
    await ctx.pool.query(
      `INSERT INTO staff_area_grants (tenant_id, user_id, area, granted_by) VALUES ($1, $2, 'fees', $3)`,
      [ids.tenantA, ids.teacherA, ids.adminA],
    );
    try {
      const finAllowed = await ctx.app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/reports/finance-summary`,
        headers: headers(teacherToken),
      });
      expect(finAllowed.statusCode).toBe(200);

      const overviewDenied = await ctx.app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/reports/overview`,
        headers: headers(teacherToken),
      });
      expect(overviewDenied.statusCode).toBe(403);
    } finally {
      await ctx.pool.query(`DELETE FROM staff_area_grants WHERE tenant_id = $1 AND user_id = $2`, [
        ids.tenantA,
        ids.teacherA,
      ]);
    }
  });

  it("S14-2, S14-3 & S14-7: financeSummary validates termId belongs to tenant (404 on unknown/foreign term) and scopes payment counts to the selected term and non-voided invoices", async () => {
    const unknownTerm = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/finance-summary?termId=00000000-0000-4000-8000-000000000999`,
      headers: headers(adminToken),
    });
    expect(unknownTerm.statusCode).toBe(404);

    // Create academic year + Term 1 and Term 2 in tenantA, and a term in tenantB
    const yrA = await ctx.pool.query<{ id: string }>(
      `INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current, created_by)
       VALUES ($1, '2026', '2026-01-01', '2026-12-31', true, $2) RETURNING id`,
      [ids.tenantA, ids.adminA],
    );
    const t1Res = await ctx.pool.query<{ id: string }>(
      `INSERT INTO academic_terms (tenant_id, academic_year_id, label, index, starts_on, ends_on, is_current, created_by)
       VALUES ($1, $2, 'Term 1', 1, '2026-01-05', '2026-04-10', true, $3) RETURNING id`,
      [ids.tenantA, yrA.rows[0]!.id, ids.adminA],
    );
    const term1Id = t1Res.rows[0]!.id;
    const t2Res = await ctx.pool.query<{ id: string }>(
      `INSERT INTO academic_terms (tenant_id, academic_year_id, label, index, starts_on, ends_on, is_current, created_by)
       VALUES ($1, $2, 'Term 2', 2, '2026-05-04', '2026-08-07', false, $3) RETURNING id`,
      [ids.tenantA, yrA.rows[0]!.id, ids.adminA],
    );
    const term2Id = t2Res.rows[0]!.id;

    const yrB = await ctx.pool.query<{ id: string }>(
      `INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current, created_by)
       VALUES ($1, '2026-B', '2026-01-01', '2026-12-31', true, $2) RETURNING id`,
      [ids.tenantB, ids.teacherB],
    );
    const termBRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO academic_terms (tenant_id, academic_year_id, label, index, starts_on, ends_on, is_current, created_by)
       VALUES ($1, $2, 'Term 1B', 1, '2026-01-05', '2026-04-10', true, $3) RETURNING id`,
      [ids.tenantB, yrB.rows[0]!.id, ids.teacherB],
    );
    const foreignTermRes = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/finance-summary?termId=${termBRes.rows[0]!.id}`,
      headers: headers(adminToken),
    });
    expect(foreignTermRes.statusCode).toBe(404);

    // Seed fee item, learner, invoices in Term 1 and Term 2, and payments in each term
    const feeItem = await ctx.pool.query<{ id: string }>(
      `INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor, applies_to, created_by)
       VALUES ($1, $2, 'Tuition Fee', 100000, 'all', $3) RETURNING id`,
      [ids.tenantA, term1Id, ids.adminA],
    );
    const feeItemId = feeItem.rows[0]!.id;

    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: headers(adminToken),
      payload: { full_name: "Finance Summary Learner", admission_no: "FS-001", date_of_birth: "2013-03-03", gender: "female" },
    });
    const learnerId = learner.json().learner.id as string;

    const inv1 = await ctx.pool.query<{ id: string }>(
      `INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on, created_by)
       VALUES ($1, $2, $3, '2026-02-01', $4) RETURNING id`,
      [ids.tenantA, learnerId, term1Id, ids.adminA],
    );
    await ctx.pool.query(
      `INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor)
       VALUES ($1, $2, $3, 'Tuition T1', 100000)`,
      [ids.tenantA, inv1.rows[0]!.id, feeItemId],
    );
    await ctx.pool.query(
      `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, reference, recorded_by, completed_at)
       VALUES ($1, $2, 40000, 'bank', 'success', 'REF-T1-1', $3, now())`,
      [ids.tenantA, inv1.rows[0]!.id, ids.adminA],
    );

    const inv2 = await ctx.pool.query<{ id: string }>(
      `INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on, created_by)
       VALUES ($1, $2, $3, '2026-06-01', $4) RETURNING id`,
      [ids.tenantA, learnerId, term2Id, ids.adminA],
    );
    await ctx.pool.query(
      `INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor)
       VALUES ($1, $2, $3, 'Tuition T2', 200000)`,
      [ids.tenantA, inv2.rows[0]!.id, feeItemId],
    );
    await ctx.pool.query(
      `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, reference, recorded_by, completed_at)
       VALUES ($1, $2, 50000, 'bank', 'success', 'REF-T2-1', $3, now()),
              ($1, $2, 30000, 'bank', 'success', 'REF-T2-2', $3, now())`,
      [ids.tenantA, inv2.rows[0]!.id, ids.adminA],
    );

    // Term 1 summary must count ONLY Term 1's 1 payment (not Term 2's 2 payments!)
    const sumT1 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/finance-summary?termId=${term1Id}`,
      headers: headers(adminToken),
    });
    expect(sumT1.statusCode, sumT1.body).toBe(200);
    expect(sumT1.json().summary).toMatchObject({
      invoices_live: 1,
      amount_due_minor: 100000,
      amount_paid_minor: 40000,
      payments_success: 1,
      payments_pending: 0,
    });

    // All-terms summary counts 3 successful payments total
    const sumAll = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/finance-summary`,
      headers: headers(adminToken),
    });
    expect(sumAll.statusCode).toBe(200);
    expect(sumAll.json().summary.payments_success).toBe(3);
  });

  it("S14-4 & S14-5: attendanceDaily rejects impossible calendar dates with 400, excludes archived learners, and excludes afternoon absent/excused marks covered by an active early sign-out", async () => {
    const badDate = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/attendance-daily?date=2026-02-31`,
      headers: headers(adminToken),
    });
    expect(badDate.statusCode).toBe(400);

    // Enable afternoon register in attendance_settings
    await ctx.pool.query(
      `INSERT INTO attendance_settings (tenant_id, afternoon_enabled, percentage_mode)
       VALUES ($1, true, 'session')
       ON CONFLICT (tenant_id) DO UPDATE SET afternoon_enabled = true`,
      [ids.tenantA],
    );

    const yr = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM academic_years WHERE tenant_id = $1 LIMIT 1`,
      [ids.tenantA],
    );
    const term = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM academic_terms WHERE tenant_id = $1 AND index = 1 LIMIT 1`,
      [ids.tenantA],
    );
    const cls = await ctx.pool.query<{ id: string }>(
      `INSERT INTO classes (tenant_id, academic_year_id, name, form_level, created_by)
       VALUES ($1, $2, 'Form 1 East', 1, $3) RETURNING id`,
      [ids.tenantA, yr.rows[0]!.id, ids.adminA],
    );
    const classId = cls.rows[0]!.id;

    const activeL = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: headers(adminToken),
      payload: { full_name: "Active Att Learner", admission_no: "AT-ACT-1", date_of_birth: "2013-04-04", gender: "male" },
    });
    const activeLearnerId = activeL.json().learner.id as string;

    const archL = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: headers(adminToken),
      payload: { full_name: "Archived Att Learner", admission_no: "AT-ARC-1", date_of_birth: "2013-05-05", gender: "male" },
    });
    const archivedLearnerId = archL.json().learner.id as string;

    const day = "2026-03-18";
    // Record morning present + afternoon absent + early sign-out for activeLearnerId
    await ctx.pool.query(
      `INSERT INTO attendance (tenant_id, class_id, term_id, learner_id, taken_on, mark, taken_by)
       VALUES ($1, $2, $3, $4, $5::date, 'present', $6),
              ($1, $2, $3, $7, $5::date, 'present', $6)`,
      [ids.tenantA, classId, term.rows[0]!.id, activeLearnerId, day, ids.adminA, archivedLearnerId],
    );
    await ctx.pool.query(
      `INSERT INTO attendance_afternoon (tenant_id, class_id, term_id, learner_id, taken_on, mark, taken_by)
       VALUES ($1, $2, $3, $4, $5::date, 'absent', $6),
              ($1, $2, $3, $7, $5::date, 'present', $6)`,
      [ids.tenantA, classId, term.rows[0]!.id, activeLearnerId, day, ids.adminA, archivedLearnerId],
    );
    await ctx.pool.query(
      `INSERT INTO early_sign_outs (tenant_id, learner_id, class_id, learner_name, class_name, taken_on, signed_out_at, signed_out_local, reason, collected_by_name, collected_by_relationship, recorded_by)
       VALUES ($1, $2, $3, 'Active Att Learner', 'Form 1 East', $4::date, now(), '11:30:00', 'Dentist visit', 'Guardian A', 'Mother', $5)`,
      [ids.tenantA, activeLearnerId, classId, day, ids.adminA],
    );

    // Archive archivedLearnerId
    await ctx.pool.query(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, [archivedLearnerId]);

    const rep = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/reports/attendance-daily?date=${day}`,
      headers: headers(adminToken),
    });
    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json().report).toEqual({
      date: day,
      morning_present: 1,
      morning_absent: 0,
      morning_late: 0,
      morning_excused: 0,
      afternoon_present: 0,
      afternoon_absent: 0,
      afternoon_late: 0,
      afternoon_excused: 0,
      early_sign_outs: 1,
    });
  });

  it("S14-6: EXPLAIN (FORMAT JSON) proves index usage on attendance, attendance_afternoon, finance_invoices, and finance_payments reporting queries", async () => {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL enable_seqscan = off");

      const queries: Array<{ sql: string; params: unknown[]; expectedIndexPattern: RegExp }> = [
        {
          sql: `EXPLAIN (FORMAT JSON) SELECT mark, count(*)::int FROM attendance WHERE tenant_id = $1 AND taken_on = $2::date GROUP BY mark`,
          params: [ids.tenantA, "2026-03-18"],
          expectedIndexPattern: /attendance_tenant_taken_on_idx/,
        },
        {
          sql: `EXPLAIN (FORMAT JSON) SELECT mark, count(*)::int FROM attendance_afternoon WHERE tenant_id = $1 AND taken_on = $2::date GROUP BY mark`,
          params: [ids.tenantA, "2026-03-18"],
          expectedIndexPattern: /attendance_afternoon_tenant_taken_on_idx/,
        },
        {
          sql: `EXPLAIN (FORMAT JSON) SELECT count(*)::int, coalesce(sum(total_minor), 0) FROM finance_invoices WHERE tenant_id = $1 AND voided_at IS NULL AND term_id = $2::uuid`,
          params: [ids.tenantA, "00000000-0000-4000-8000-000000000111"],
          expectedIndexPattern: /finance_invoices_live_term_idx|finance_invoices_learner_term_live_uidx/,
        },
        {
          sql: `EXPLAIN (FORMAT JSON) SELECT count(*)::int FROM finance_payments WHERE tenant_id = $1 AND status = 'success'`,
          params: [ids.tenantA],
          expectedIndexPattern: /finance_payments_tenant_status_idx/,
        },
      ];

      for (const q of queries) {
        const res = await c.query(q.sql, q.params);
        const planJson = JSON.stringify(res.rows[0]);
        expect(planJson).toMatch(q.expectedIndexPattern);
        expect(planJson).not.toContain('"Node Type":"Seq Scan"');
      }
      await c.query("ROLLBACK");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});
