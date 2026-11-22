import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppPool } from "../src/db/pool.js";
import { MaintenanceError, recordHeartbeat, runMaintenance } from "../src/worker/runtime.js";
import { financeHarness, PASSWORD } from "./support/financeHarness.js";

/**
 * The glue the worker process actually runs every cycle: recordHeartbeat (liveness) and runMaintenance (import-preview expiry,
 * reconciliation-case sweep, unmatched-callback sweep). The sweeps are proven elsewhere by calling the SQL directly; this test
 * proves the WIRING: executed as the real figbloom_worker login through the runtime functions, with the effects observable in the
 * database and on the operator status endpoint, and proves the worker's main loop really calls both.
 */
describe("worker maintenance and heartbeat wiring", () => {
  const h = financeHarness();
  const pool = () => h.workerPool as unknown as AppPool;

  it("the worker main loop calls recordHeartbeat and runMaintenance (the glue is not dead code)", () => {
    const text = readFileSync(join(process.cwd(), "src", "worker", "index.ts"), "utf8");
    expect(text).toMatch(/await recordHeartbeat\(pool, config\.workerName,/);
    expect(text).toMatch(/await runMaintenance\(pool, config\.workerName\)/);
    expect(text).toMatch(/import \{[^}]*recordHeartbeat[^}]*runMaintenance[^}]*\} from "\.\/runtime\.js"|import \{[^}]*runMaintenance[^}]*recordHeartbeat[^}]*\} from "\.\/runtime\.js"/);
  });

  it("recordHeartbeat, as the worker, creates a liveness row that the platform status endpoint reports (ages only)", async () => {
    const name = "maint-hb-" + randomUUID().slice(0, 6);
    await recordHeartbeat(pool(), name, "alive");
    const row = (await h.owner(`SELECT worker_name, last_cycle_outcome, extract(epoch FROM now() - last_seen_at)::int AS age FROM worker_heartbeats WHERE worker_name = $1`, [name]))[0]!;
    expect(row).toMatchObject({ worker_name: name, last_cycle_outcome: "alive" });
    expect(row.age).toBeLessThan(30);
    const su = (await h.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "super@example.com", password: PASSWORD } })).json().token as string;
    const status = (await h.call("GET", "/v1/platform/ops/status", su)).json().status;
    const seen = (status.workers as { worker: string; last_seen_age_seconds: number; last_cycle_outcome: string }[]).find((w) => w.worker === name);
    expect(seen).toBeDefined();
    expect(seen!.last_seen_age_seconds).toBeLessThan(30);
    expect(seen!.last_cycle_outcome).toBe("alive");
    // a second beat updates, never duplicates
    await recordHeartbeat(pool(), name, "ok");
    expect((await h.owner(`SELECT count(*)::int AS n FROM worker_heartbeats WHERE worker_name = $1`, [name]))[0]!.n).toBe(1);
    expect((await h.owner(`SELECT last_cycle_outcome FROM worker_heartbeats WHERE worker_name = $1`, [name]))[0]!.last_cycle_outcome).toBe("ok");
  });

  it("runMaintenance expires old import previews, raises a case for a dead settlement job, evaluates and escalates a stale unmatched callback, and reports honest counts", async () => {
    // 1. an unapplied import preview whose retention has elapsed (raw PII must be redacted)
    const preview = (await h.owner(
      `INSERT INTO import_batches (tenant_id, kind, status, row_count, valid_count, payload_sha256, preview_json, created_by, created_at, expires_at)
       VALUES ($1, 'learners_csv', 'previewed', 1, 1, repeat('c', 64), '{"rows":[{"full_name":"Raw Pii Person"}]}'::jsonb, $2, now() - interval '9 days', now() - interval '2 days') RETURNING id`,
      [h.A(), h.ids.adminA],
    ))[0]!.id as string;
    // 2. a settlement job that went dead while the payment is still pending
    const inv = await h.freshInvoice(1_000_000);
    const p = await h.startPrompt(inv, 100_000);
    await h.owner(`UPDATE jobs SET status = 'dead', finished_at = now(), lease_expires_at = NULL, leased_by = NULL, last_error_code = 'provider_pending' WHERE idempotency_key = $1`, [`settle:${p.payment.id}`]);
    // 3. a provider success that matched no payment, older than the 4-hour escalation threshold
    const checkout = "ws_CO_MAINT_" + randomUUID().slice(0, 8);
    expect((await h.sendCallback(h.callbackBody(checkout, 0, { amount: 100, receipt: "MAINT" + randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase() }))).statusCode).toBe(200);
    await h.owner(`UPDATE finance_unmatched_cases SET first_seen_at = now() - interval '5 hours' WHERE checkout_request_id = $1`, [checkout]);

    const out = await runMaintenance(pool(), "maint-worker");

    expect(out.previewsRedacted).toBeGreaterThanOrEqual(1);
    expect(out.casesRaised).toBeGreaterThanOrEqual(1);
    expect(out.unmatchedEvaluated).toBeGreaterThanOrEqual(1);
    expect(out.unmatchedEscalated).toBeGreaterThanOrEqual(1);
    // effects in the database, not just return values
    const batch = (await h.owner(`SELECT status, preview_json::text AS pj FROM import_batches WHERE id = $1`, [preview]))[0]!;
    expect(batch.pj).not.toContain("Raw Pii Person");
    expect(batch.status).not.toBe("previewed");
    expect(await h.owner(`SELECT 1 FROM finance_reconciliation_findings WHERE subject_id = $1 AND kind = 'dead_settlement_job' AND status = 'open'`, [p.payment.id])).toHaveLength(1);
    expect((await h.payment(p.payment.id)).status).toBe("pending"); // a dead job never fails the payment
    const um = (await h.owner(`SELECT escalated_at, last_evaluated_at, status FROM finance_unmatched_cases WHERE checkout_request_id = $1`, [checkout]))[0]!;
    expect(um.escalated_at).toBeTruthy();
    expect(um.last_evaluated_at).toBeTruthy();
    expect(um.status).toBe("open"); // the worker never decides an outcome
    // the sweeps leave a worker audit trail with no actor and no secrets
    const audit = await h.owner(`SELECT detail::text AS d, actor_user_id FROM security_audit_events WHERE event_type = 'finance.unmatched.escalated' AND detail->>'worker' = 'maint-worker'`);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.actor_user_id).toBeNull();
    // idempotent: a second run escalates and raises nothing new
    const again = await runMaintenance(pool(), "maint-worker");
    expect(again.unmatchedEscalated).toBe(0);
    expect(again.casesRaised).toBe(0);
    expect(again.previewsRedacted).toBe(0);
  });

  it("only the worker role can run the maintenance sweeps (the application role is refused)", async () => {
    // every step is attempted (failure isolation) and each one is refused by the database for a non-worker login
    const err = await runMaintenance(h.ctx.runtimePool as unknown as AppPool, "app-should-fail").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MaintenanceError);
    // 5 prior sweeps + storage_abandoned_cleanup (090) + export_jobs_expire (091) = 7 worker-only sweeps
    expect((err as MaintenanceError).failed.length).toBe(7);
    for (const f of (err as MaintenanceError).failed) expect(f.endsWith(":42501"), f).toBe(true);
  });
});
