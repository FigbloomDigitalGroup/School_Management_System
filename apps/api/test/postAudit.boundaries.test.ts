import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { financeHarness } from "./support/financeHarness.js";

/** Post-remediation audit N-4, N-5, N-7, N-8 (migrations 066, 067), exercised as figbloom_app / figbloom_worker. */
describe("post-audit: sick-bay finality, gate-visit deletion, medical-notice policies, import preview retention", () => {
  const h = financeHarness();
  const sqlState = (p: Promise<unknown>) => h.sqlState(p);

  async function appTx<T>(tenant: string, user: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await h.ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenant, user ?? ""]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  /** Run one statement inside a savepoint so a refusal does not abort the surrounding transaction. */
  async function attempt(c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<string | null> {
    await c.query("SAVEPOINT a");
    try {
      await c.query(sql, params);
      await c.query("RELEASE SAVEPOINT a");
      return null;
    } catch (err) {
      await c.query("ROLLBACK TO SAVEPOINT a");
      return (err as { code?: string }).code ?? "unknown";
    }
  }
  async function learner(tenant = h.A(), name = "PA Learner"): Promise<string> {
    return (await h.owner<{ id: string }>(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, $3, 'female') RETURNING id`, [tenant, "PA" + randomUUID().slice(0, 8), name]))[0]!.id;
  }

  // ---------------------------------------------------------------- N-4
  it("N-4: a discharged sick-bay visit needs a FRESH, reasoned, attributed correction in every statement; no stale reason, no reopening", async () => {
    const l = await learner();
    await appTx(h.A(), h.ids.adminA, async (c) => {
      const v = (await c.query<{ id: string }>(`INSERT INTO sick_bay_visits (tenant_id, learner_id, complaint, logged_by) VALUES ($1, $2, 'headache', $3) RETURNING id`, [h.A(), l, h.ids.adminA])).rows[0]!.id;
      expect(await attempt(c, `UPDATE sick_bay_visits SET treatment = 'rest' WHERE id = $1`, [v])).toBeNull(); // normal update before discharge
      expect(await attempt(c, `UPDATE sick_bay_visits SET time_out = now(), outcome = 'home' WHERE id = $1`, [v])).toBeNull(); // first discharge
      expect(await attempt(c, `UPDATE sick_bay_visits SET treatment = 'silent change' WHERE id = $1`, [v])).toBe("23514"); // no reason
      expect(await attempt(c, `UPDATE sick_bay_visits SET treatment = 'x', correction_reason = 'ab' WHERE id = $1`, [v])).toBe("23514"); // too short
      expect(await attempt(c, `UPDATE sick_bay_visits SET time_out = NULL, correction_reason = 'reopen me' WHERE id = $1`, [v])).toBe("23514"); // reopening
      expect(await attempt(c, `UPDATE sick_bay_visits SET treatment = 'typo fixed', correction_reason = 'typo in treatment' WHERE id = $1`, [v])).toBeNull(); // valid correction
      const after1 = (await c.query(`SELECT correction_reason, row_version, treatment FROM sick_bay_visits WHERE id = $1`, [v])).rows[0]!;
      expect(after1.correction_reason).toBeNull(); // consumed: nothing stale remains on the row
      expect(after1.treatment).toBe("typo fixed");
      // N-4 itself: the SECOND edit with no reason must be refused (the old guard accepted the stale one)
      expect(await attempt(c, `UPDATE sick_bay_visits SET treatment = 'again, no reason' WHERE id = $1`, [v])).toBe("23514");
      // a repeated correction with the same text is legitimate IF supplied in the statement
      expect(await attempt(c, `UPDATE sick_bay_visits SET treatment = 'second fix', correction_reason = 'typo in treatment' WHERE id = $1`, [v])).toBeNull();
      const hist = (await c.query(`SELECT reason, corrected_by, row_version FROM sick_bay_visit_corrections WHERE visit_id = $1 ORDER BY row_version`, [v])).rows;
      expect(hist.map((r) => r.reason)).toEqual(["typo in treatment", "typo in treatment"]);
      expect(hist.every((r) => r.corrected_by === h.ids.adminA)).toBe(true); // attributable
      // unattributed (no signed-in user) correction refused
      await c.query(`SELECT set_config('app.user_id', '', true)`);
      expect(await attempt(c, `UPDATE sick_bay_visits SET treatment = 'anon', correction_reason = 'no user context' WHERE id = $1`, [v])).toBe("42501");
      // the app can read but never write corrections directly
      expect(await attempt(c, `INSERT INTO sick_bay_visit_corrections (tenant_id, visit_id, row_version, reason) VALUES ($1, $2, 99, 'forged history')`, [h.A(), v])).toBe("42501");
      // cross-tenant: school B cannot see or correct school A's visit
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [h.ids.tenantB, h.ids.teacherB]);
      const upd = await c.query(`UPDATE sick_bay_visits SET treatment = 'x', correction_reason = 'cross tenant' WHERE id = $1`, [v]);
      expect(upd.rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM sick_bay_visit_corrections WHERE visit_id = $1`, [v])).rowCount).toBe(0);
    });
  });

  it("N-4: concurrent corrections serialise on the row; both are recorded and the version advances twice", async () => {
    const l = await learner();
    const v = (await h.owner<{ id: string }>(`INSERT INTO sick_bay_visits (tenant_id, learner_id, complaint, logged_by, time_out, outcome) VALUES ($1, $2, 'c', $3, now(), 'home') RETURNING id`, [h.A(), l, h.ids.adminA]))[0]!.id;
    const open = async (reason: string) => {
      const c = await h.ctx.runtimePool.connect();
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [h.A(), h.ids.adminA]);
      return { c, run: () => c.query(`UPDATE sick_bay_visits SET treatment = $2, correction_reason = $3 WHERE id = $1`, [v, reason, reason]) };
    };
    const s1 = await open("first concurrent fix");
    const s2 = await open("second concurrent fix");
    try {
      await s1.run();
      const p2 = s2.run(); // blocks on s1's row lock
      await new Promise((r) => setTimeout(r, 300));
      await s1.c.query("COMMIT");
      await p2;
      await s2.c.query("COMMIT");
    } finally {
      s1.c.release();
      s2.c.release();
    }
    const hist = await h.owner<{ reason: string }>(`SELECT reason FROM sick_bay_visit_corrections WHERE visit_id = $1`, [v]);
    expect(hist.map((r) => r.reason).sort()).toEqual(["first concurrent fix", "second concurrent fix"]);
    expect((await h.owner<{ row_version: number }>(`SELECT row_version FROM sick_bay_visits WHERE id = $1`, [v]))[0]!.row_version).toBe(3);
  });

  // ---------------------------------------------------------------- N-5
  it("N-5: deleting a learner keeps the gate visit as history (learner_id NULL, name snapshot, same tenant); invalid combinations stay invalid", async () => {
    const l = await learner(h.A(), "Visited Learner");
    const gv = (await h.owner<{ id: string }>(`INSERT INTO gate_visits (tenant_id, visitor_name, purpose, host_kind, learner_id) VALUES ($1, 'Aunt', 'visit', 'learner', $2) RETURNING id`, [h.A(), l]))[0]!.id;
    const office = (await h.owner<{ id: string }>(`INSERT INTO gate_visits (tenant_id, visitor_name, purpose, host_kind) VALUES ($1, 'Courier', 'parcel', 'office') RETURNING id`, [h.A()]))[0]!.id;
    await h.owner(`DELETE FROM learners WHERE id = $1`, [l]);
    expect((await h.owner(`SELECT tenant_id, host_kind, learner_id, learner_name FROM gate_visits WHERE id = $1`, [gv]))[0]).toMatchObject({ tenant_id: h.A(), host_kind: "learner", learner_id: null, learner_name: "Visited Learner" });
    expect((await h.owner(`SELECT host_kind, learner_id FROM gate_visits WHERE id = $1`, [office]))[0]).toMatchObject({ host_kind: "office", learner_id: null });
    // a learner-hosted visit must still name a learner at this school
    expect(await sqlState(h.owner(`INSERT INTO gate_visits (tenant_id, visitor_name, purpose, host_kind) VALUES ($1, 'X', 'p', 'learner')`, [h.A()]))).toBe("22023");
    const other = await learner(h.ids.tenantB, "Other School");
    expect(await sqlState(h.owner(`INSERT INTO gate_visits (tenant_id, visitor_name, purpose, host_kind, learner_id) VALUES ($1, 'X', 'p', 'learner', $2)`, [h.A(), other]))).not.toBeNull(); // cross-tenant learner
    // the table CHECK itself rejects a learner host with neither id nor snapshot
    expect(await sqlState(h.owner(`ALTER TABLE gate_visits DISABLE TRIGGER gate_visits_stamp; INSERT INTO gate_visits (tenant_id, visitor_name, purpose, host_kind, learner_id, learner_name) VALUES ('${h.A()}', 'X', 'p', 'learner', NULL, NULL)`))).toBe("23514");
    await h.owner(`ALTER TABLE gate_visits ENABLE TRIGGER gate_visits_stamp`);
    // archival (the normal path) leaves the visit untouched
    const l2 = await learner(h.A(), "Archived Learner");
    const gv2 = (await h.owner<{ id: string }>(`INSERT INTO gate_visits (tenant_id, visitor_name, purpose, host_kind, learner_id) VALUES ($1, 'Uncle', 'visit', 'learner', $2) RETURNING id`, [h.A(), l2]))[0]!.id;
    await h.owner(`UPDATE learners SET archived_at = now(), active = false WHERE id = $1`, [l2]);
    expect((await h.owner(`SELECT learner_id, learner_name FROM gate_visits WHERE id = $1`, [gv2]))[0]).toMatchObject({ learner_id: l2, learner_name: "Archived Learner" });
  });

  // ---------------------------------------------------------------- N-7
  it("N-7: only staff may create a medical notice, only for a parent member of the same school; a guardian sees and marks-read only their own", async () => {
    const l = await learner();
    const v = (await h.owner<{ id: string }>(`INSERT INTO sick_bay_visits (tenant_id, learner_id, complaint, logged_by) VALUES ($1, $2, 'fever', $3) RETURNING id`, [h.A(), l, h.ids.adminA]))[0]!.id;
    const ins = (guardian: string): [string, unknown[]] => [`INSERT INTO medical_notices (tenant_id, visit_id, guardian_user_id, learner_id, outcome, summary) VALUES ($1, $2, $3, $4, 'home', 'sent home')`, [h.A(), v, guardian, l]];
    await appTx(h.A(), h.ids.adminA, async (c) => {
      expect(await attempt(c, ...ins(h.ids.parentA))).toBeNull(); // staff -> parent: allowed (it was blocked by 063)
      expect(await attempt(c, ...ins(h.ids.teacherA))).toBe("42501"); // guardian must be a parent member
      expect(await attempt(c, `INSERT INTO medical_notices (tenant_id, visit_id, guardian_user_id, learner_id, outcome, summary) VALUES ($1, $2, $3, $4, 'home', 'x')`, [h.ids.tenantB, v, h.ids.parentA, l])).not.toBeNull(); // wrong tenant
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [h.ids.parentA]);
      expect(await attempt(c, ...ins(h.ids.parentA))).toBe("42501"); // a parent is not staff
      expect((await c.query(`SELECT 1 FROM medical_notices`)).rowCount).toBe(1); // the guardian reads their own
      expect(await attempt(c, `UPDATE medical_notices SET read_at = now()`)).toBeNull(); // and marks it read
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [h.ids.teacherA]);
      expect((await c.query(`SELECT 1 FROM medical_notices`)).rowCount).toBe(0); // another member of the same school sees nothing
    });
  });

  // ---------------------------------------------------------------- N-8
  const workerTx = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await h.workerPool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const sweep = () => workerTx((c) => c.query<{ n: number }>(`SELECT public.import_batches_expire_due(200) AS n`)).then((r) => r.rows[0]!.n);
  async function batch(tenant: string, status: string, expiresInSeconds: number): Promise<string> {
    return (
      await h.owner<{ id: string }>(
        `INSERT INTO import_batches (tenant_id, kind, status, row_count, valid_count, payload_sha256, preview_json, created_by, created_at, expires_at, applied_by, applied_at)
         VALUES ($1, 'learners_csv', $2::text, 1, 1, repeat('b', 64), '{"rows":[{"full_name":"Raw Pii Person","admission_no":"RAW1"}],"errors":[]}'::jsonb, $3::uuid,
                 now() - interval '1 day', now() + make_interval(secs => $4::int), CASE WHEN $2::text = 'applied' THEN $3::uuid END, CASE WHEN $2::text = 'applied' THEN now() END) RETURNING id`,
        [tenant, status, h.ids.adminA, expiresInSeconds],
      )
    )[0]!.id;
  }

  it("N-8: the sweep redacts only expired, unapplied previews (all tenants, row by row), audits each, and is repeatable", async () => {
    await sweep(); // drain leftovers from earlier tests
    const dueA = await batch(h.A(), "previewed", -60);
    const dueB = await batch(h.ids.tenantB, "previewed", -60);
    const fresh = await batch(h.A(), "previewed", 3600);
    const applied = await batch(h.A(), "applied", -60);
    expect(await sweep()).toBe(2);
    const st = async (id: string) => (await h.owner(`SELECT status, preview_json FROM import_batches WHERE id = $1`, [id]))[0]!;
    for (const id of [dueA, dueB]) {
      const r = await st(id);
      expect(r.status).toBe("expired");
      expect(r.preview_json).toMatchObject({ redacted: true, reason: "expired", row_count: 1 });
      expect(JSON.stringify(r.preview_json)).not.toMatch(/Raw Pii|RAW1|rows/);
    }
    expect((await st(fresh)).status).toBe("previewed");
    expect(JSON.stringify((await st(fresh)).preview_json)).toContain("Raw Pii Person"); // active imports are not destroyed
    expect((await st(applied)).status).toBe("applied");
    expect(await sweep()).toBe(0); // repeated cleanup is a no-op
    // audited, per tenant, with attribution and without PII; audit rows are retained
    const evA = (await h.auditOf("import.learners.preview_expired")).filter((e) => e.detail.importId === dueA);
    const evB = (await h.auditOf("import.learners.preview_expired", h.ids.tenantB)).filter((e) => e.detail.importId === dueB);
    expect(evA).toHaveLength(1);
    expect(evB).toHaveLength(1);
    expect(evA[0]!.detail).toMatchObject({ actingVia: "worker", rowCount: 1 });
    expect(JSON.stringify(evA[0]!.detail)).not.toMatch(/Raw Pii/);
    // only the worker may run it
    expect(await sqlState(h.asApp(h.A(), (c) => c.query(`SELECT public.import_batches_expire_due(10)`)))).toBe("42501");
  });

  it("N-8: concurrent apply and cleanup — a batch locked by an apply is skipped by the sweep and redacted afterwards", async () => {
    await sweep();
    const id = await batch(h.A(), "previewed", -60);
    const holder = await h.ctx.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM import_batches WHERE id = $1 FOR UPDATE`, [id]); // what apply does
      expect(await sweep()).toBe(0);
      expect((await h.owner(`SELECT status FROM import_batches WHERE id = $1`, [id]))[0]!.status).toBe("previewed");
      await holder.query("COMMIT");
    } finally {
      holder.release();
    }
    expect(await sweep()).toBe(1);
  });

  it("N-8 (end to end via the API): a previewed import expires, its PII is gone, and it can never be applied; a live preview still applies", async () => {
    const csv = "admission_no,full_name,gender,date_of_birth,boarding\nPAE2E1,Expiry Test,male,2014-01-01,false\n";
    const url = `/v1/tenants/${h.A()}/imports/learners`;
    const p1 = await h.call("POST", `${url}/preview`, h.admin, { csv });
    expect(p1.statusCode).toBe(200);
    const id1 = p1.json().preview.import_id as string;
    expect((await h.owner(`SELECT expires_at > now() AS live FROM import_batches WHERE id = $1`, [id1]))[0]!.live).toBe(true);
    // expiry passes (before any sweep): apply refuses, then the sweep redacts it
    await h.owner(`UPDATE import_batches SET expires_at = now() - interval '1 second' WHERE id = $1`, [id1]);
    const late = await h.call("POST", `${url}/apply`, h.admin, { import_id: id1 });
    expect(late.statusCode).toBe(409);
    await sweep();
    expect((await h.owner(`SELECT status, preview_json FROM import_batches WHERE id = $1`, [id1]))[0]).toMatchObject({ status: "expired" });
    const again = await h.call("POST", `${url}/apply`, h.admin, { import_id: id1 });
    expect(again.statusCode).toBe(409);
    expect((await h.owner(`SELECT 1 FROM learners WHERE tenant_id = $1 AND admission_no = 'PAE2E1'`, [h.A()])).length).toBe(0);
    // a live preview applies exactly once; replay by the owner is safe; its PII is redacted at apply (062)
    const p2 = await h.call("POST", `${url}/preview`, h.admin, { csv: csv.replace("PAE2E1", "PAE2E2") });
    const id2 = p2.json().preview.import_id as string;
    const ok = await h.call("POST", `${url}/apply`, h.admin, { import_id: id2 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result.created_count).toBe(1);
    expect((await h.call("POST", `${url}/apply`, h.admin, { import_id: id2 })).json().result.replayed).toBe(true);
    expect(JSON.stringify((await h.owner(`SELECT preview_json FROM import_batches WHERE id = $1`, [id2]))[0]!.preview_json)).not.toContain("Expiry Test");
  });
});
