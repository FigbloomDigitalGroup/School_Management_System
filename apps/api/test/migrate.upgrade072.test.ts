import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { MIGRATIONS_DIR } from "./support/migrationTables.js";
import { runMigrations, verifyMigrations } from "../src/db/migrate.js";
import { LOCAL_SESSION_MINT_HMAC_KEY } from "../src/modules/auth/sessionProof.js";

/**
 * Workstream 3: a SEEDED upgrade from the state at migration 072 to the latest migration (073 onward), with representative data
 * across two schools. The legacy unmatched-callback quarantine (which had no cases) must be back-filled into cases without losing
 * or rewriting a single evidence row; financial values, tenant ownership and existing relationships must be untouched; the run
 * must be idempotent. Destructive by design: it drops the schema, so it runs only against the verified disposable database
 * (the global setup refuses anything else; see docs/TEST-DATABASE-SAFETY.md).
 */
describe("seeded upgrade 072 -> latest (migrations 073+)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const staging = mkdtempSync(join(tmpdir(), "figbloom-mig-072-"));

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    rmSync(staging, { recursive: true, force: true });
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("carries two schools of data across, back-fills unmatched-callback cases, keeps money and tenancy intact and is idempotent", async () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    const upTo072 = all.filter((f) => Number(f.split("_")[0]) <= 72);
    const after = all.filter((f) => Number(f.split("_")[0]) > 72);
    expect(upTo072).toHaveLength(72);
    expect(after.length).toBeGreaterThanOrEqual(3);
    mkdirSync(join(staging, "m"));
    for (const f of upTo072) copyFileSync(join(MIGRATIONS_DIR, f), join(staging, "m", f));

    // 1. a pristine database at exactly the 072 state, built by the real runner from the real files
    await ctx.pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO PUBLIC;`);
    const base = await runMigrations(ctx.pool, { migrationsDir: join(staging, "m") });
    expect(base.applied).toEqual(upTo072);
    await ctx.pool.query(`SELECT public.auth_install_session_hmac_secret('local', $1)`, [LOCAL_SESSION_MINT_HMAC_KEY]);

    // 2. representative data in two schools (identifiers are fixed so the assertions can be exact)
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const [org, tA, tB, uAdminA, uParentA, uAdminB, learnerA, learnerB, guardianA, guardianB, year, term, invoice] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(id);
    const q = (sql: string, p: unknown[] = []) => ctx.pool.query(sql, p);
    await q(`INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, 'Up Org', 'up-org', 'group_owner', 'active')`, [org]);
    await q(`INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $3, 'Up A', 'up-a', 'active'), ($2, $3, 'Up B', 'up-b', 'active')`, [tA, tB, org]);
    await q(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES
              ($1, 'up-admin-a@example.com', 'scrypt$legacy$hash', 'Admin A', 'active'),
              ($2, 'up-parent-a@example.com', 'scrypt$legacy$hash2', 'Parent A', 'active'),
              ($3, 'up-admin-b@example.com', 'scrypt$legacy$hash3', 'Admin B', 'active')`, [uAdminA, uParentA, uAdminB]);
    await q(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $4, 'school_admin', 'AD-0001'), ($2, $4, 'parent', 'PT-0001'), ($3, $5, 'school_admin', 'AD-0001')`, [uAdminA, uParentA, uAdminB, tA, tB]);
    await q(`INSERT INTO sessions (user_id, token_hash, active_tenant_id, expires_at) VALUES ($1, 'up-session-hash-1', $2, now() + interval '4 hours')`, [uAdminA, tA]);
    await q(`INSERT INTO learners (id, tenant_id, admission_no, full_name, gender) VALUES ($1, $3, 'UP-A1', 'Learner A', 'female'), ($2, $4, 'UP-B1', 'Learner B', 'male')`, [learnerA, learnerB, tA, tB]);
    await q(`INSERT INTO guardians (id, tenant_id, full_name, email, phone) VALUES ($1, $3, 'Guardian A', 'ga@example.com', '0712000001'), ($2, $4, 'Guardian B', 'gb@example.com', '0712000002')`, [guardianA, guardianB, tA, tB]);
    await q(`INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship, is_primary_payer) VALUES ($1, $3, $4, 'mother', true), ($2, $5, $6, 'father', false)`, [tA, tB, guardianA, learnerA, guardianB, learnerB]);
    await q(`INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on) VALUES ($1, $2, '2026', '2026-01-01', '2026-12-31')`, [year, tA]);
    await q(`INSERT INTO academic_terms (id, tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, $3, 1, 'T1', '2026-01-01', '2026-12-31')`, [term, tA, year]);
    await q(`INSERT INTO finance_invoices (id, tenant_id, learner_id, term_id, due_on, lines_minor, total_minor) VALUES ($1, $2, $3, $4, '2026-12-31', 1000000, 1000000)`, [invoice, tA, learnerA, term]);
    const feeItem = (await q(`INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor, applies_to) VALUES ($1, $2, 'Tuition', 1000000, 'all') RETURNING id`, [tA, term])).rows[0].id as string;
    await q(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'Tuition', 1000000)`, [tA, invoice, feeItem]);
    await q(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, reference, completed_at, recorded_by) VALUES ($1, $2, 400000, 'bank', 'success', 'BANKREF1', now(), $3)`, [tA, invoice, uAdminA]);
    const pendingId = (await q(
      `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254712345678', 'ws_CO_UP_PENDING') RETURNING id`,
      [tA, invoice],
    )).rows[0].id as string;
    await q(`INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, outcome) VALUES ($1, $2, 'ws_CO_UP_PENDING', 'status_query', 0, 'provider_pending')`, [tA, pendingId]);
    const run = (await q(`INSERT INTO finance_reconciliation_runs (tenant_id, started_by, stale_after_minutes) VALUES ($1, $2, 30) RETURNING id`, [tA, uAdminA])).rows[0].id as string;
    await q(`INSERT INTO finance_reconciliation_findings (tenant_id, run_id, kind, subject_type, subject_id, detail) VALUES ($1, $2, 'stale_pending_prompt', 'payment', $3, '{}'::jsonb)`, [tA, run, pendingId]);
    await q(`INSERT INTO account_tokens (kind, token_hash, tenant_id, email, role, created_by, expires_at) VALUES ('invitation', repeat('a', 64), $1, 'new-staff@example.com', 'teacher', $2, now() + interval '1 day')`, [tA, uAdminA]);
    // the legacy quarantine: U1 repeated identically (2), plus a DIFFERENT payload for U1 (contradictory), plus U2
    await q(`INSERT INTO finance_mpesa_unmatched_callbacks (checkout_request_id, merchant_request_id, result_code, callback_amount_minor, receipt, msisdn_masked, received_at) VALUES
              ('ws_CO_U1', 'MR1', 0, 10000, 'LEGACYR001', '254*****5678', now() - interval '3 days'),
              ('ws_CO_U1', 'MR1', 0, 10000, 'LEGACYR001', '254*****5678', now() - interval '2 days'),
              ('ws_CO_U1', 'MR1', 0, 25000, 'LEGACYR002', '254*****5678', now() - interval '1 day'),
              ('ws_CO_U2', 'MR2', 1032, NULL, NULL, NULL, now() - interval '1 hour')`);

    const snapshot = async () => ({
      // every column that existed at 072: migration 117 legitimately adds tenants.hr_requested_at and hr_requested_by (null until a school asks for HR)
      tenants: (await q(`SELECT md5(string_agg((to_jsonb(t) - 'hr_requested_at' - 'hr_requested_by')::text, '|' ORDER BY id)) AS h, count(*)::int AS n FROM tenants t`)).rows[0],
      users: (await q(`SELECT md5(string_agg(u::text, '|' ORDER BY id)) AS h, count(*)::int AS n FROM users u`)).rows[0],
      members: (await q(`SELECT md5(string_agg(m::text, '|' ORDER BY id)) AS h, count(*)::int AS n FROM school_memberships m`)).rows[0],
      learners: (await q(`SELECT md5(string_agg(l::text, '|' ORDER BY id)) AS h, count(*)::int AS n FROM learners l`)).rows[0],
      guardians: (await q(`SELECT md5(string_agg(g::text, '|' ORDER BY id)) AS h, count(*)::int AS n FROM guardians g`)).rows[0],
      links: (await q(`SELECT md5(string_agg(l::text, '|' ORDER BY id)) AS h, count(*)::int AS n FROM guardian_links l`)).rows[0],
      invoice: (await q(`SELECT total_minor, paid_minor, lines_minor FROM finance_invoices WHERE id = $1`, [invoice])).rows[0],
      payments: (await q(`SELECT id, amount_minor, status, mpesa_receipt, checkout_request_id FROM finance_payments ORDER BY id`)).rows,
      events: (await q(`SELECT md5(string_agg(e::text, '|' ORDER BY id)) AS h, count(*)::int AS n FROM finance_mpesa_events e`)).rows[0],
      // the columns that existed at 072: migration 077 legitimately adds sessions.reauthenticated_at
      sessions: (await q(`SELECT md5(string_agg(concat_ws('|', id, user_id, token_hash, active_tenant_id, active_organization_id, expires_at, revoked_at, created_at, last_seen_at), ';' ORDER BY id)) AS h FROM sessions`)).rows[0],
      unmatchedRaw: (await q(`SELECT checkout_request_id, merchant_request_id, result_code, callback_amount_minor, receipt, msisdn_masked, received_at FROM finance_mpesa_unmatched_callbacks ORDER BY received_at`)).rows,
    });
    const before = await snapshot();
    expect(before.invoice).toEqual({ total_minor: "1000000", paid_minor: "400000", lines_minor: "1000000" });
    expect(before.unmatchedRaw).toHaveLength(4);

    // 3. the upgrade: the REAL runner, on the real files, over the seeded data
    const started = Date.now();
    const up = await runMigrations(ctx.pool);
    const elapsedMs = Date.now() - started;
    expect(up.applied).toEqual(after);
    expect(elapsedMs).toBeLessThan(60_000);

    // 4. nothing that existed was changed
    const afterSnap = await snapshot();
    expect(afterSnap).toEqual(before);

    // 5. unmatched callbacks were back-filled into cases without touching the evidence rows
    const cases = (await q(`SELECT checkout_request_id, status, occurrences, contradictory, reopened_count, owner_user_id, first_seen_at, last_seen_at FROM finance_unmatched_cases ORDER BY checkout_request_id`)).rows;
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ checkout_request_id: "ws_CO_U1", status: "open", occurrences: 3, contradictory: true, reopened_count: 0, owner_user_id: null });
    expect(cases[1]).toMatchObject({ checkout_request_id: "ws_CO_U2", status: "open", occurrences: 1, contradictory: false });
    expect(new Date(cases[0]!.first_seen_at).getTime()).toBe(new Date(before.unmatchedRaw[0]!.received_at).getTime());
    const orphan = await q(`SELECT count(*)::int AS n FROM finance_mpesa_unmatched_callbacks WHERE case_id IS NULL OR evidence_key IS NULL`);
    expect(orphan.rows[0].n).toBe(0);
    const keys = (await q(`SELECT count(DISTINCT evidence_key)::int AS k FROM finance_mpesa_unmatched_callbacks WHERE checkout_request_id = 'ws_CO_U1'`)).rows[0].k;
    expect(keys).toBe(2); // the contradictory payload is a distinct piece of evidence

    // 6. the new structures exist and are locked down; nothing was granted to the runtime roles
    for (const t of ["guardian_invitations", "guardian_accounts", "finance_unmatched_cases", "finance_unmatched_case_notes"]) {
      const f = (await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`, [t])).rows[0];
      expect(f, t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect((await q(`SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = $1 AND grantee IN ('figbloom_app', 'figbloom_worker')`, [t])).rowCount, t).toBe(0);
    }
    expect((await q(`SELECT count(*)::int AS n FROM guardian_invitations`)).rows[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM guardian_accounts`)).rows[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid IN ('public.guardian_invitations'::regclass, 'public.guardian_accounts'::regclass, 'public.finance_unmatched_cases'::regclass) AND NOT convalidated`)).rows[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('guardian_invitations_open_uidx', 'guardian_accounts_active_guardian_uidx', 'guardian_accounts_active_user_guardian_uidx', 'finance_unmatched_cases_status_idx')`)).rows[0].n).toBe(4);
    expect((await q(`SELECT code FROM permissions WHERE code IN ('platform.ops.read', 'platform.finance.unmatched.manage') ORDER BY code`)).rows.map((r) => r.code)).toEqual(["platform.finance.unmatched.manage", "platform.ops.read"]);
    // the existing parent membership is untouched and the existing guardian relationship is still the only one
    expect((await q(`SELECT role FROM school_memberships WHERE user_id = $1 AND tenant_id = $2`, [uParentA, tA])).rows[0].role).toBe("parent");

    // 7. idempotent: a second run applies nothing and every checksum verifies
    const again = await runMigrations(ctx.pool);
    expect(again.applied).toEqual([]);
    expect((await verifyMigrations(ctx.pool)).verified).toHaveLength(all.length);

    // 8. a callback arriving AFTER the upgrade lands in the back-filled case (no duplicate case) and a contradictory one is preserved
    await q(`SELECT public.finance_mpesa_record_unmatched('ws_CO_U2', 'MR2', 0, 5000, 'POSTUPG001', '254*****5678')`);
    const u2 = (await q(`SELECT occurrences, contradictory FROM finance_unmatched_cases WHERE checkout_request_id = 'ws_CO_U2'`)).rows;
    expect(u2).toEqual([{ occurrences: 2, contradictory: true }]);
    expect((await q(`SELECT count(*)::int AS n FROM finance_unmatched_cases`)).rows[0].n).toBe(2);

    // restore the standard fixtures for any later file
    await ctx.app.close();
    await ctx.pool.end();
    ctx = await createTestApp();
  }, 300_000);
});
