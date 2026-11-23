import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { financeHarness } from "./support/financeHarness.js";

/**
 * Mutation checks for the post-audit invariants (audit Phase 7). For each protection: (1) the attack is refused,
 * (2) the protection is deliberately WEAKENED in this disposable test database (the function text is taken from the
 * migration file and one condition is removed), (3) the very same attack now SUCCEEDS — proving the test detects the
 * missing protection, (4) the original text is restored and the attack is refused again. Not a claim of
 * comprehensive mutation coverage: seven selected invariants.
 */
describe("post-audit: selected mutation checks (the guarding tests fail when the protection is weakened)", () => {
  const h = financeHarness();
  const MIG = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8");

  /** The CREATE [OR REPLACE] FUNCTION block of `name`, as CREATE OR REPLACE. */
  function fn(file: string, name: string): string {
    const m = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(MIG(file));
    if (!m) throw new Error(`${name} not found in ${file}`);
    return m[0].replace(/^CREATE FUNCTION/, "CREATE OR REPLACE FUNCTION");
  }
  const mutate = (sql: string, from: string, to: string): string => {
    if (!sql.includes(from)) throw new Error(`mutation anchor not found: ${from.slice(0, 60)}`);
    return sql.split(from).join(to);
  };
  /** attack must be refused; weaken; attack must succeed; restore; attack must be refused again. */
  async function killed(opts: { name: string; original: string; mutated: string; attack: () => Promise<boolean>; extraMutate?: string; extraRestore?: string }) {
    expect(await opts.attack(), `${opts.name}: attack must be refused before the mutation`).toBe(false);
    await h.owner(opts.mutated);
    if (opts.extraMutate) await h.owner(opts.extraMutate);
    try {
      expect(await opts.attack(), `${opts.name}: attack must SUCCEED once the protection is removed (test detects the weakening)`).toBe(true);
    } finally {
      await h.owner(opts.original);
      if (opts.extraRestore) await h.owner(opts.extraRestore);
    }
  }

  async function pending() {
    const inv = await h.freshInvoice(1_000_000);
    const p = await h.startPrompt(inv, 100_000);
    return { id: p.payment.id as string, checkout: p.checkout, inv };
  }
  async function workerTx<T>(fnx: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await h.workerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [h.A()]);
      const r = await fnx(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  /** A fresh pending payment with a freshly CLAIMED (real jobs_claim) job. */
  async function claimed(seconds = 120) {
    const p = await pending();
    await h.owner(`UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued' AND idempotency_key <> $1`, [`settle:${p.id}`]);
    await h.makeDue(p.id);
    const j = (await workerTx((c) => c.query<{ id: string; attempts: number; lease_token: string }>(`SELECT id, attempts, lease_token FROM jobs_claim('mut-w', $1, ARRAY['mpesa.stk_settle'])`, [seconds]))).rows[0]!;
    return { p, j };
  }
  const settle = (j: { id: string; attempts: number; lease_token: string }, pid: string, status: string, receipt: string | null, reason: string | null) =>
    workerTx((c) => c.query<{ o: string }>(`SELECT public.finance_worker_settle_payment($1, $2, $3, $4, $5, $6, $7) AS o`, [j.id, j.lease_token, j.attempts, pid, status, receipt, reason])).then((r) => r.rows[0]!.o).catch(() => "refused");
  const payStatus = async (id: string) => (await h.owner<{ status: string }>(`SELECT status FROM finance_payments WHERE id = $1`, [id]))[0]!.status;

  it("M1 (N-1): removing the failure-evidence requirement lets a leased worker fail a payment with no provider evidence", async () => {
    const original = fn("065_worker_evidence_and_lease_tokens.sql", "finance_worker_settle_payment");
    const mutated = mutate(original, "IF v_fail_code IS NULL OR v_has_success THEN", "v_fail_code := coalesce(v_fail_code, 1032); IF false THEN");
    await killed({
      name: "M1", original, mutated,
      attack: async () => {
        const { p, j } = await claimed();
        await settle(j, p.id, "cancelled", null, "cancelled");
        return (await payStatus(p.id)) === "cancelled";
      },
    });
  });

  it("M2 (N-1): removing the stored-callback requirement lets a worker credit a payment with an invented receipt", async () => {
    const original = fn("065_worker_evidence_and_lease_tokens.sql", "finance_worker_settle_payment");
    const mutated = mutate(original, "RAISE EXCEPTION 'success settlement requires a stored authenticated callback receipt' USING ERRCODE = '42501';", "NULL;");
    await killed({
      name: "M2", original, mutated,
      attack: async () => {
        const { p, j } = await claimed();
        await settle(j, p.id, "success", "INVENTED00001", null);
        return (await payStatus(p.id)) === "success";
      },
    });
  });

  it("M3 (N-2): removing the token predicate lets anyone who knows only the readable label complete another worker's job", async () => {
    const original = fn("065_worker_evidence_and_lease_tokens.sql", "jobs_complete");
    const mutated = mutate(original, "AND j.lease_token = p_lease_token AND j.attempts = p_attempt", "AND j.attempts = p_attempt");
    await killed({
      name: "M3", original, mutated,
      attack: async () => {
        const { p, j } = await claimed();
        const ok = (await workerTx((c) => c.query<{ o: boolean }>(`SELECT public.jobs_complete($1, 'not-the-token', $2) AS o`, [j.id, j.attempts]))).rows[0]!.o;
        await h.owner(`UPDATE jobs SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, leased_by = NULL, run_after = now() + interval '1 day' WHERE idempotency_key = $1 AND status = 'succeeded' AND false`, [`settle:${p.id}`]);
        return ok;
      },
    });
  });

  it("M4 (N-2): removing the maximum lease duration lets a worker keep a job leased indefinitely", async () => {
    const original = fn("065_worker_evidence_and_lease_tokens.sql", "jobs_extend_lease");
    let mutated = mutate(original, "j.lease_started_at + make_interval(secs => v_cap))", "now() + interval '100 years')");
    mutated = mutate(mutated, "AND j.lease_expires_at < j.lease_started_at + make_interval(secs => v_cap)", "");
    await killed({
      name: "M4", original, mutated,
      attack: async () => {
        const { j } = await claimed(60);
        await workerTx((c) => c.query(`SELECT public.jobs_extend_lease($1, $2, $3, 3600)`, [j.id, j.lease_token, j.attempts])).catch(() => undefined);
        await workerTx((c) => c.query(`SELECT public.jobs_extend_lease($1, $2, $3, 3600)`, [j.id, j.lease_token, j.attempts])).catch(() => undefined);
        const gap = (await h.owner<{ gap: number }>(`SELECT extract(epoch FROM (lease_expires_at - lease_started_at))::int AS gap FROM jobs WHERE id = $1`, [j.id]))[0]!.gap;
        return gap > 3600;
      },
    });
  });

  it("M5 (N-3): giving the worker audit INSERT back (and an open trigger) lets it forge settlement events", async () => {
    const original = fn("065_worker_evidence_and_lease_tokens.sql", "security_audit_events_worker_scope");
    const mutated = mutate(original, "RAISE EXCEPTION 'the worker role cannot write audit events directly; they are emitted by trusted functions' USING ERRCODE = '42501';", "NULL;");
    await killed({
      name: "M5", original, mutated,
      extraMutate: "GRANT INSERT ON public.security_audit_events TO figbloom_worker",
      extraRestore: "REVOKE INSERT ON public.security_audit_events FROM figbloom_worker",
      attack: async () => {
        try {
          await workerTx((c) => c.query(`INSERT INTO security_audit_events (tenant_id, event_type, detail) VALUES ($1, 'finance.mpesa.settled', '{"actingVia":"worker","forged":true}'::jsonb)`, [h.A()]));
          return true;
        } catch {
          return false;
        }
      },
    });
    await h.owner(`DELETE FROM security_audit_events WHERE detail->>'forged' = 'true'`).catch(() => undefined);
  });

  it("M6 (N-4): removing the stale-reason guard and the consumption lets a discharged visit be edited with no new reason", async () => {
    const original = fn("066_sick_bay_finality_gate_visit_notices.sql", "sick_bay_visits_guard");
    let mutated = mutate(original, "IF OLD.correction_reason IS NOT NULL AND NEW.correction_reason IS NOT DISTINCT FROM OLD.correction_reason THEN", "IF false THEN");
    mutated = mutate(mutated, "NEW.correction_reason := NULL;", "NULL;");
    const learner = (await h.owner<{ id: string }>(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Mut', 'male') RETURNING id`, [h.A(), "MUT" + Date.now()]))[0]!.id;
    const attack = async (): Promise<boolean> => {
      const v = (await h.owner<{ id: string }>(`INSERT INTO sick_bay_visits (tenant_id, learner_id, complaint, logged_by, time_out, outcome) VALUES ($1, $2, 'm', $3, now(), 'home') RETURNING id`, [h.A(), learner, h.ids.adminA]))[0]!.id;
      const c = await h.ctx.runtimePool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [h.A(), h.ids.adminA]);
        await c.query(`UPDATE sick_bay_visits SET treatment = 'first', correction_reason = 'a real reason' WHERE id = $1`, [v]);
        await c.query("SAVEPOINT s");
        try {
          await c.query(`UPDATE sick_bay_visits SET treatment = 'second, no reason' WHERE id = $1`, [v]);
          return true;
        } catch {
          return false;
        }
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    };
    await killed({ name: "M6", original, mutated, attack });
  });

  it("M7 (N-8): breaking the expiry predicate stops the sweep, so unapplied previews would keep their PII", async () => {
    const original = fn("067_import_preview_retention.sql", "import_batches_expire_due");
    const mutated = mutate(original, "b.expires_at <= now()", "false");
    const attack = async (): Promise<boolean> => {
      const id = (await h.owner<{ id: string }>(`INSERT INTO import_batches (tenant_id, kind, status, row_count, valid_count, payload_sha256, preview_json, created_by, created_at, expires_at) VALUES ($1, 'learners_csv', 'previewed', 1, 1, repeat('c', 64), '{"rows":[{"full_name":"Keeps Pii"}]}'::jsonb, $2, now() - interval '1 day', now() - interval '1 minute') RETURNING id`, [h.A(), h.ids.adminA]))[0]!.id;
      await workerTx((c) => c.query(`SELECT public.import_batches_expire_due(200)`));
      return (await h.owner<{ status: string }>(`SELECT status FROM import_batches WHERE id = $1`, [id]))[0]!.status === "previewed"; // true = PII survived the sweep
    };
    // here the "attack" is "the PII survives the sweep": false while the protection works, true when weakened
    await killed({ name: "M7", original, mutated, attack });
  });
});
