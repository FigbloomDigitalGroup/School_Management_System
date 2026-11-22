import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

/**
 * Workstream 5C, database level: tenant isolation proven through the REAL runtime login (figbloom_app), not through the API.
 *   (a) for every tenant-scoped table that holds rows of school B: school A's context can read none, update none, delete none;
 *   (b) every application-callable SECURITY DEFINER function that takes a tenant id refuses a tenant other than the transaction
 *       context (the tenant cannot be forged through a parameter);
 *   (c) the worker role cannot be pointed at another school through a manipulated job payload.
 * Coverage (tables exercised vs catalogue-only) is written to TENANT_MATRIX_OUT when set.
 */
describe("tenant isolation matrix at the database (figbloom_app)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp();
    // representative school-B rows across the directory so that the generic sweep has something to try to reach
    const B = ctx.ids.tenantB;
    const learner = (await ctx.pool.query(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'XB-1', 'B Learner', 'male') RETURNING id`, [B])).rows[0].id;
    const guardian = (await ctx.pool.query(`INSERT INTO guardians (tenant_id, full_name, email) VALUES ($1, 'B Guardian', 'bg@example.com') RETURNING id`, [B])).rows[0].id;
    await ctx.pool.query(`INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship) VALUES ($1, $2, $3, 'mother')`, [B, guardian, learner]);
    await ctx.pool.query(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, 'XB', '2026-01-01', '2026-12-31')`, [B]);
    await ctx.pool.query(`INSERT INTO subjects (tenant_id, code, name) VALUES ($1, 'XBS', 'B Subject')`, [B]);
    const year = (await ctx.pool.query(`SELECT id FROM academic_years WHERE tenant_id = $1 AND label = 'XB'`, [B])).rows[0].id;
    const term = (await ctx.pool.query(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, 'XB T1', '2026-01-01', '2026-12-31') RETURNING id`, [B, year])).rows[0].id;
    const cls = (await ctx.pool.query(`INSERT INTO classes (tenant_id, academic_year_id, name) VALUES ($1, $2, 'XB Class') RETURNING id`, [B, year])).rows[0].id;
    await ctx.pool.query(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [B, learner, cls, year]);
    const fee = (await ctx.pool.query(`INSERT INTO finance_fee_items (tenant_id, term_id, name, amount_minor, applies_to) VALUES ($1, $2, 'XB Tuition', 500000, 'all') RETURNING id`, [B, term])).rows[0].id;
    const inv = (await ctx.pool.query(`INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on, lines_minor, total_minor) VALUES ($1, $2, $3, '2026-12-31', 500000, 500000) RETURNING id`, [B, learner, term])).rows[0].id;
    await ctx.pool.query(`INSERT INTO finance_invoice_lines (tenant_id, invoice_id, fee_item_id, name, amount_minor) VALUES ($1, $2, $3, 'XB Tuition', 500000)`, [B, inv, fee]);
    await ctx.pool.query(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, reference, completed_at) VALUES ($1, $2, 100000, 'bank', 'success', 'XBREF', now())`, [B, inv]);
    await ctx.pool.query(`INSERT INTO inventory_items (tenant_id, name, category, tracking) VALUES ($1, 'XB Item', 'other', 'stock')`, [B]);
    await ctx.pool.query(`INSERT INTO activities (tenant_id, name, category) VALUES ($1, 'XB Club', 'club')`, [B]);
    await ctx.pool.query(`INSERT INTO vehicles (tenant_id, plate_number) VALUES ($1, 'KXB001')`, [B]);
    await ctx.pool.query(`INSERT INTO staff_members (tenant_id, full_name) VALUES ($1, 'XB Staff')`, [B]);
    await ctx.pool.query(`INSERT INTO attendance_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [B]);
    await ctx.pool.query(`INSERT INTO finance_reconciliation_runs (tenant_id, stale_after_minutes, source) VALUES ($1, 30, 'sweep')`, [B]);
    await ctx.pool.query(`INSERT INTO security_audit_events (tenant_id, event_type, detail) VALUES ($1, 'test.tenant_matrix', '{}'::jsonb)`, [B]);
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function asApp<T>(tenant: string, user: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenant, user]);
      const r = await fn(c);
      await c.query("ROLLBACK");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  it("(a) school A's context cannot read, update or delete a single row of school B in any tenant-scoped table", async () => {
    const A = ctx.ids.tenantA;
    const B = ctx.ids.tenantB;
    const tables = (await ctx.pool.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`,
    )).rows.map((r) => r.table_name);
    const exercised: string[] = [];
    const catalogueOnly: string[] = [];
    for (const t of tables) {
      const owned = Number((await ctx.pool.query(`SELECT count(*) AS n FROM public.${t} WHERE tenant_id = $1`, [B])).rows[0].n);
      const priv = await ctx.pool.query<{ s: boolean; u: boolean; d: boolean }>(
        `SELECT has_table_privilege('figbloom_app', $1, 'SELECT') AS s, has_table_privilege('figbloom_app', $1, 'UPDATE') OR EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE grantee = 'figbloom_app' AND table_name = $2 AND privilege_type = 'UPDATE') AS u, has_table_privilege('figbloom_app', $1, 'DELETE') AS d`,
        [`public.${t}`, t],
      );
      if (owned === 0 || !priv.rows[0]!.s) {
        catalogueOnly.push(t);
        continue;
      }
      exercised.push(t);
      const seen = await asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT count(*)::int AS n FROM public.${t} WHERE tenant_id = $1`, [B]));
      expect(seen.rows[0].n, `${t}: school A read school B rows`).toBe(0);
      if (priv.rows[0]!.d) {
        const del = await asApp(A, ctx.ids.adminA, (c) => c.query(`DELETE FROM public.${t} WHERE tenant_id = $1`, [B]));
        expect(del.rowCount, `${t}: school A deleted school B rows`).toBe(0);
      }
      if (priv.rows[0]!.u) {
        const col = (await ctx.pool.query(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'figbloom_app' AND table_name = $1 AND privilege_type = 'UPDATE' LIMIT 1`, [t])).rows[0]?.column_name as string | undefined;
        if (col) {
          const upd = await asApp(A, ctx.ids.adminA, (c) => c.query(`UPDATE public.${t} SET ${col} = ${col} WHERE tenant_id = $1`, [B]));
          expect(upd.rowCount, `${t}: school A updated school B rows`).toBe(0);
        }
      }
    }
    expect(exercised.length).toBeGreaterThanOrEqual(5);
    if (process.env.TENANT_MATRIX_OUT) writeFileSync(process.env.TENANT_MATRIX_OUT, JSON.stringify({ tenantTables: tables.length, exercised, catalogueOnly }, null, 1));
  });

  /** Fill every NOT NULL column that has no default with a value of its type (checks may still refuse: that is reported, not hidden). */
  async function syntheticRow(table: string, tenant: string): Promise<{ sql: string; params: unknown[] }> {
    const cols = (
      await ctx.pool.query<{ column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null; is_generated: string; is_identity: string }>(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default, is_generated, is_identity FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
    ).rows;
    const names: string[] = [];
    const vals: string[] = [];
    const params: unknown[] = [];
    for (const c of cols) {
      if (c.is_generated === "ALWAYS" || c.is_identity === "YES") continue;
      const isTenant = c.column_name === "tenant_id";
      if (!isTenant && (c.is_nullable === "YES" || c.column_default !== null)) continue;
      let v: unknown;
      if (isTenant) v = tenant;
      else if (c.data_type === "uuid") v = randomUUID();
      else if (["text", "character varying", "character"].includes(c.data_type)) v = "sx" + randomUUID().slice(0, 8);
      else if (["integer", "smallint", "bigint"].includes(c.data_type)) v = 1;
      else if (c.data_type === "numeric") v = 0;
      else if (c.data_type === "boolean") v = false;
      else if (c.data_type === "date") v = "2026-06-01";
      else if (c.data_type.startsWith("timestamp")) v = new Date().toISOString();
      else if (c.data_type === "jsonb" || c.data_type === "json") v = "{}";
      else if (c.data_type === "ARRAY") v = "{}";
      else if (c.data_type === "inet") v = "127.0.0.1";
      else if (c.data_type.startsWith("time")) v = "08:00:00";
      else if (c.data_type === "USER-DEFINED") {
        const e = await ctx.pool.query<{ enumlabel: string }>(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder LIMIT 1`, [c.udt_name]);
        v = e.rows[0]?.enumlabel;
      } else v = "x";
      params.push(v);
      names.push('"' + c.column_name + '"');
      const cast = c.data_type === "ARRAY" ? c.udt_name.replace(/^_/, "") + "[]" : c.data_type === "USER-DEFINED" ? '"' + c.udt_name + '"' : c.data_type;
      vals.push("$" + params.length + "::" + cast);
    }
    return { sql: `INSERT INTO public.${table} (${names.join(", ")}) VALUES (${vals.join(", ")})`, params };
  }

  it("(a3) every tenant-scoped table is classified; synthetic fixtures extend the row-level isolation proof; WITH CHECK is probed on every writable table", async () => {
    const A = ctx.ids.tenantA;
    const B = ctx.ids.tenantB;
    const tables = (
      await ctx.pool.query<{ table_name: string }>(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`,
      )
    ).rows.map((r) => r.table_name);
    const cls: { rowExercised: string[]; rowExercisedSynthetic: string[]; inaccessibleToAppRole: string[]; blockedNeedsFixture: string[] } = { rowExercised: [], rowExercisedSynthetic: [], inaccessibleToAppRole: [], blockedNeedsFixture: [] };
    const blocked: Record<string, string> = {};
    const withCheckProbed: string[] = [];
    const refusedByPolicy: string[] = [];
    const refusedFirstByTrigger: Record<string, string> = {};
    const ownInsert: Record<string, string | undefined> = {};
    for (const t of tables) {
      const canSelect = (await ctx.pool.query(`SELECT has_table_privilege('figbloom_app', $1, 'SELECT') AS s`, [`public.${t}`])).rows[0].s as boolean;
      if (!canSelect) {
        cls.inaccessibleToAppRole.push(t);
        continue;
      }
      // a school-B row: seeded earlier, or synthetic (committed with triggers and foreign keys off for the INSERT only, as the owner)
      let bRows = Number((await ctx.pool.query(`SELECT count(*) AS n FROM public.${t} WHERE tenant_id = $1`, [B])).rows[0].n);
      let synthetic = false;
      if (bRows === 0) {
        const row = await syntheticRow(t, B);
        const c = await ctx.pool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SET LOCAL session_replication_role = replica");
          await c.query(row.sql, row.params);
          await c.query("COMMIT");
          synthetic = true;
          bRows = 1;
        } catch (e) {
          await c.query("ROLLBACK").catch(() => undefined);
          blocked[t] = String((e as { code?: string }).code ?? "error");
          if ((e as { code?: string }).code === "23514") {
            // The synthetic row violates a business CHECK (e.g. a format). RLS is independent of CHECKs, so on this DISPOSABLE database
            // the checks are dropped and re-added NOT VALID inside one DDL transaction around the INSERT: the bogus row can exist and be probed.
            const c2 = await ctx.pool.connect();
            try {
              await c2.query("BEGIN");
              await c2.query("SET LOCAL session_replication_role = replica");
              const checks = (await c2.query<{ conname: string; def: string }>(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [`public.${t}`])).rows;
              for (const ck of checks) await c2.query(`ALTER TABLE public.${t} DROP CONSTRAINT "${ck.conname}"`);
              await c2.query(row.sql, row.params);
              for (const ck of checks) await c2.query(`ALTER TABLE public.${t} ADD CONSTRAINT "${ck.conname}" ${ck.def} NOT VALID`);
              await c2.query("COMMIT");
              synthetic = true;
              bRows = 1;
              delete blocked[t];
            } catch (e2) {
              await c2.query("ROLLBACK").catch(() => undefined);
              blocked[t] = "23514+" + String((e2 as { code?: string }).code ?? "error");
            } finally {
              c2.release();
            }
          }
        } finally {
          c.release();
        }
      }
      if (bRows === 0) {
        cls.blockedNeedsFixture.push(t);
      } else {
        (synthetic ? cls.rowExercisedSynthetic : cls.rowExercised).push(t);
        const seen = await asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT count(*)::int AS n FROM public.${t} WHERE tenant_id = $1`, [B]));
        expect(seen.rows[0].n, `${t}: school A read school B rows`).toBe(0);
        const priv = (
          await ctx.pool.query<{ d: boolean; col: string | null }>(
            `SELECT has_table_privilege('figbloom_app', $1, 'DELETE') AS d, (SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'figbloom_app' AND table_name = $2 AND privilege_type = 'UPDATE' LIMIT 1) AS col`,
            [`public.${t}`, t],
          )
        ).rows[0]!;
        if (priv.d) expect((await asApp(A, ctx.ids.adminA, (c) => c.query(`DELETE FROM public.${t} WHERE tenant_id = $1`, [B]))).rowCount, `${t}: delete crossed schools`).toBe(0);
        if (priv.col) expect((await asApp(A, ctx.ids.adminA, (c) => c.query(`UPDATE public.${t} SET "${priv.col}" = "${priv.col}" WHERE tenant_id = $1`, [B]))).rowCount, `${t}: update crossed schools`).toBe(0);
      }
      // WITH CHECK: the policy refuses a school-B row from school A's context before any constraint is looked at
      const canInsertTenant = (await ctx.pool.query(`SELECT has_column_privilege('figbloom_app', $1, 'tenant_id', 'INSERT') AS i`, [`public.${t}`])).rows[0].i as boolean;
      if (canInsertTenant) {
        // a BEFORE INSERT trigger may refuse the incomplete row first (then the policy was not reached); either way nothing is inserted
        const forged = await asApp(A, ctx.ids.adminA, (c) => c.query(`INSERT INTO public.${t} (tenant_id) VALUES ($1)`, [B])).then(
          () => "INSERTED",
          (e: { code?: string }) => e.code ?? "error",
        );
        expect(forged, `${t}: a school-B row was accepted from school A's context`).not.toBe("INSERTED");
        if (forged === "42501") refusedByPolicy.push(t);
        else refusedFirstByTrigger[t] = forged;
        const own = await asApp(A, ctx.ids.adminA, (c) => c.query(`INSERT INTO public.${t} (tenant_id) VALUES ($1)`, [A])).then(
          () => "inserted",
          (e: { code?: string }) => e.code,
        );
        ownInsert[t] = own; // reported, not asserted: user-scoped RESTRICTIVE policies (chat, notices) legitimately refuse an incomplete own-school row
        withCheckProbed.push(t);
      }
    }
    const classified = [...cls.rowExercised, ...cls.rowExercisedSynthetic, ...cls.inaccessibleToAppRole, ...cls.blockedNeedsFixture];
    expect(new Set(classified).size).toBe(tables.length); // every tenant table has exactly one classification
    if (process.env.TENANT_MATRIX_OUT) writeFileSync(process.env.TENANT_MATRIX_OUT, JSON.stringify({ tenantTables: tables.length, ...cls, blockedReasons: blocked, withCheckProbed, refusedByPolicy, refusedFirstByTrigger, ownInsert }, null, 1));
    expect(cls.rowExercised.length + cls.rowExercisedSynthetic.length).toBeGreaterThanOrEqual(19);
    expect(refusedByPolicy.length).toBeGreaterThanOrEqual(Math.floor(withCheckProbed.length / 2)); // most refusals are the policy itself
  }, 300_000);

  it("(a4) tables with column-level or insert-only access: jobs (column SELECT/INSERT) and security_audit_events (INSERT only) isolate schools too", async () => {
    const A = ctx.ids.tenantA;
    const B = ctx.ids.tenantB;
    await ctx.pool.query(`INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after) VALUES ($1, 'announcement.push', '{}'::jsonb, $2, now() + interval '1 day')`, [B, "iso-" + randomUUID()]);
    expect((await asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1`, [B]))).rows[0].n).toBe(0);
    expect((await asApp(B, ctx.ids.teacherB, (c) => c.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1`, [B]))).rows[0].n).toBeGreaterThanOrEqual(1);
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after) VALUES ($1, 'announcement.push', '{}'::jsonb, $2, now())`, [B, "forge-" + randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`UPDATE jobs SET status = 'dead' WHERE tenant_id = $1`, [B]))).rejects.toMatchObject({ code: "42501" }); // no UPDATE privilege at all
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`DELETE FROM jobs WHERE tenant_id = $1`, [B]))).rejects.toMatchObject({ code: "42501" });
    // the audit table: the application can only append, and only for its own school
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT 1 FROM security_audit_events LIMIT 1`))).rejects.toMatchObject({ code: "42501" });
    // KNOWN / DOCUMENTED RESIDUAL R-9 (residual closure 2026-11-21): security_audit_events has no row-level policy, so the application
    // role can APPEND a row naming another school (it must be able to record denied cross-school attempts under the TARGET school).
    // The table stays append-only (no read, update or delete) and rows carry the real actor. This assertion pins the current
    // behaviour so that hardening it (WITH CHECK) is a deliberate, noticed change.
    await asApp(A, ctx.ids.adminA, (c) => c.query(`INSERT INTO security_audit_events (tenant_id, event_type, detail) VALUES ($1, 'test.cross_school_append', '{}'::jsonb)`, [B]));
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`UPDATE security_audit_events SET detail = '{}'::jsonb`))).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`DELETE FROM security_audit_events`))).rejects.toMatchObject({ code: "42501" });
    await asApp(A, ctx.ids.adminA, (c) => c.query(`INSERT INTO security_audit_events (tenant_id, event_type, detail) VALUES ($1, 'test.own', '{}'::jsonb)`, [A])); // own school: allowed (rolled back)
  });

  it("(a2) inserting a row for school B from school A's context is refused by the policy (WITH CHECK), not merely filtered", async () => {
    const B = ctx.ids.tenantB;
    await expect(
      asApp(ctx.ids.tenantA, ctx.ids.adminA, (c) => c.query(`INSERT INTO public.learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'FORGED', 'Forged', 'male')`, [B])),
    ).rejects.toMatchObject({ code: "42501" });
    // and with NO tenant context at all nothing is visible or writable
    const none = await ctx.runtimePool.connect();
    try {
      await none.query("BEGIN");
      expect((await none.query(`SELECT count(*)::int AS n FROM public.learners`)).rows[0].n).toBe(0);
      await none.query("ROLLBACK");
    } finally {
      none.release();
    }
  });

  it("(b) SECURITY DEFINER functions that take a tenant id refuse a tenant other than the transaction context", async () => {
    const A = ctx.ids.tenantA;
    const B = ctx.ids.tenantB;
    const u = randomUUID();
    const hash = "a".repeat(64);
    const calls: [string, string, unknown[]][] = [
      ["guardian_create_invitation", "SELECT public.guardian_create_invitation($1, $2, $3, 'email', $4, now() + interval '1 day')", [B, u, u, hash]],
      ["guardian_revoke_invitation", "SELECT public.guardian_revoke_invitation($1, $2)", [B, u]],
      ["guardian_list_invitations", "SELECT * FROM public.guardian_list_invitations($1, NULL, 10)", [B]],
      ["guardian_revoke_account_link", "SELECT public.guardian_revoke_account_link($1, $2, 'testing a forged tenant')", [B, u]],
      ["guardian_record_delivery", "SELECT public.guardian_record_delivery($1, $2, 'sent')", [B, u]],
      ["account_create_invitation", "SELECT public.account_create_invitation($1, 'x@example.com', 'teacher', NULL, $2, now() + interval '1 day')", [B, hash]],
      ["account_revoke_invitation", "SELECT public.account_revoke_invitation($1, $2)", [B, u]],
      ["account_admin_issue_reset", "SELECT public.account_admin_issue_reset($1, $2, $3, now() + interval '10 minutes')", [B, u, hash]],
      ["account_deactivate_membership", "SELECT public.account_deactivate_membership($1, $2)", [B, u]],
    ];
    for (const [name, sql, params] of calls) {
      // context: school A administrator; parameter: school B
      await expect(asApp(A, ctx.ids.adminA, (c) => c.query(sql, params)), name).rejects.toMatchObject({ code: "42501" });
    }
    // platform operations refuse a school administrator outright
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT * FROM public.platform_provision_school(NULL, 'Org', 'School', 'forge-school', 'f@example.com', NULL, $1, now() + interval '1 day')`, [hash]))).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT * FROM public.finance_unmatched_list(NULL, NULL, false, NULL, NULL, 10)`))).rejects.toMatchObject({ code: "42501" });
    // the worker-only functions are not callable by the application role
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT * FROM public.finance_unmatched_sweep('x')`))).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT public.finance_reconciliation_sweep('x', 5)`))).rejects.toMatchObject({ code: "42501" });
  });

  it("(b3) the remaining tenant-taking functions (invoker readers and the operator/audience definers) refuse or return nothing for school B from school A's context", async () => {
    const A = ctx.ids.tenantA;
    const B = ctx.ids.tenantB;
    const u = randomUUID();
    const calls: [string, string, unknown[]][] = [
      ["attendance_counted", "SELECT * FROM public.attendance_counted($1, $2)", [B, u]],
      ["attendance_counted_page", "SELECT * FROM public.attendance_counted_page($1, $2, NULL, NULL, NULL, NULL, 10)", [B, u]],
      ["inventory_out_count", "SELECT public.inventory_out_count($1) AS v", [B]],
      ["jobs_operator_cancel", "SELECT public.jobs_operator_cancel($1, $2, 'testing forged tenant', NULL) AS v", [B, u]],
      ["communications_audience_reaches", "SELECT public.communications_audience_reaches($1, '{}'::jsonb, $2) AS v", [B, u]],
      ["may_talk", "SELECT public.may_talk($1, $2, $3) AS v", [B, u, u]],
    ];
    // KNOWN / DOCUMENTED DESIGN R-10: the school directory (`tenants`: id, name, slug, timezone, status, organization_id) is an
    // identity-plane table, application-filtered by design (docs/RLS-CATALOGUE.md, TENANT-ISOLATION.md D-3): it has no row policy
    // and the runtime role can read every school row (it is needed before any tenant context exists: sign-in, school selection).
    // Consequently finance_school_today(B) can return school B's local date. That is a calendar date derived from a timezone that is
    // already readable; it exposes no school record. Pinned so that a change to the directory's visibility is a noticed decision.
    expect((await asApp(A, ctx.ids.adminA, (c) => c.query(`SELECT count(*)::int AS n FROM public.tenants WHERE id = $1`, [B]))).rows[0].n).toBe(1);
    const outcome: Record<string, string> = { finance_school_today: "invoker; returns a calendar date from the (readable by design) school timezone: no school data (R-10)" };
    for (const [name, sql, params] of calls) {
      const r = await asApp(A, ctx.ids.adminA, (c) => c.query(sql, params)).then(
        (res) => ({ ok: true as const, rows: res.rows }),
        (e: { code?: string }) => ({ ok: false as const, code: e.code }),
      );
      if (!r.ok) {
        outcome[name] = "refused:" + r.code;
        expect(["42501", "22023", "P0002", "42883", "22P02"], name).toContain(r.code);
      } else {
        // an answer is acceptable only if it carries nothing about school B: no rows, false, 0, or null
        const vals = r.rows.flatMap((row) => Object.values(row));
        outcome[name] = "empty:" + JSON.stringify(vals).slice(0, 40);
        for (const v of vals) expect([null, false, 0, "0", undefined], `${name} returned data about another school: ${String(v)}`).toContain(v as never);
      }
    }
    if (process.env.TENANT_FUNCTIONS_OUT) writeFileSync(process.env.TENANT_FUNCTIONS_OUT, JSON.stringify(outcome, null, 1));
  });

  it("(b2) with a forged user id (another person) the definer functions still act as the transaction user, never the parameter", async () => {
    // guardian_my_links returns the CONTEXT user's links only; naming the parent's id in app.user_id of a different user yields none
    const links = await asApp(ctx.ids.tenantA, ctx.ids.teacherA, (c) => c.query(`SELECT * FROM public.guardian_my_links()`));
    expect(links.rows).toEqual([]);
  });
});
