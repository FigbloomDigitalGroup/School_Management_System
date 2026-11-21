import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { settlePrompt } from "../src/modules/finance/mpesa.js";
import { PermanentJobError, RetryableJobError, runCycle } from "../src/worker/runtime.js";
import { financeHarness, type Json } from "./support/financeHarness.js";

/**
 * Remediation batch 1: the settlement job is a SYSTEM obligation; worker audit conformance, lease
 * safety and audit integrity (review F-5, F-6, F-7, F-10, F-11; WORKER-ISOLATION-PROPOSAL §6-§8).
 */
describe("Stage 11 remediation batch 1: system jobs, audit and lease safety", () => {
  const h = financeHarness();

  /** A prompt with its settle job made due. Returns the payment, checkout id and job row. */
  async function dueJob(amount = 100_000) {
    const inv = await h.freshInvoice(1_000_000);
    const { payment, checkout } = await h.startPrompt(inv, amount);
    // isolate: only THIS test's job is due (earlier tests leave queued jobs behind)
    await h.owner(`UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued'`);
    await h.makeDue(payment.id);
    return { inv, payment, checkout, job: (await h.jobOf(payment.id))! };
  }

  describe("system-obligation classification", () => {
    it("enqueues the settlement with no enqueuer, keeps the initiator in the immutable payload and the audit trail", async () => {
      const { payment, job } = await dueJob();
      expect(job.enqueued_by_user_id).toBeNull();
      expect(job.payload).toEqual({ paymentId: payment.id, initiatedBy: h.ids.adminA });
      const started = (await h.auditOf("finance.mpesa.prompt_started")).filter((e) => e.detail.paymentId === payment.id);
      expect(started).toHaveLength(1);
      expect(started[0]!.actor_user_id).toBe(h.ids.adminA);
      // the payload is immutable: even the owner role cannot rewrite who started it
      expect(await h.sqlState(h.ctx.pool.query(`UPDATE jobs SET payload = '{}'::jsonb WHERE id = $1`, [job.id]))).toBe("23514");
    });

    it("still runs when the initiating user is disabled (the obligation does not depend on them)", async () => {
      const { payment, checkout, job } = await dueJob();
      h.fake.queries.set(checkout, { done: true, resultCode: 0 }); // success without a receipt: handler runs, stays pending
      await h.owner(`UPDATE users SET status = 'disabled' WHERE id = $1`, [h.ids.adminA]);
      try {
        expect(await h.cycle()).toEqual(["retry"]); // processed (not cancelled, not rejected)
      } finally {
        await h.owner(`UPDATE users SET status = 'active' WHERE id = $1`, [h.ids.adminA]);
      }
      const after = (await h.jobOf(payment.id))!;
      expect(after.status).toBe("queued");
      expect(after.last_error_code).toBe("provider_pending");
      expect(after.id).toBe(job.id);
      expect((await h.payment(payment.id)).status).toBe("pending");
    });

    it("still runs when the initiating user's school membership is removed", async () => {
      const { payment, checkout } = await dueJob();
      await h.plantFailureCallback(payment.id, checkout, 1032);
      h.fake.queries.set(checkout, { done: true, resultCode: 1032 }); // provider says cancelled: the worker records it
      await h.owner(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [h.ids.adminA, h.A()]);
      try {
        expect(await h.cycle()).toEqual(["succeeded"]);
      } finally {
        await h.owner(`UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`, [h.ids.adminA, h.A()]);
      }
      expect((await h.payment(payment.id)).status).toBe("cancelled");
      expect((await h.jobOf(payment.id))!.status).toBe("succeeded");
    });

    it("a suspended ORGANISATION does not cancel or block a school's settlement; a suspended SCHOOL still holds it", async () => {
      const { payment, checkout } = await dueJob();
      await h.plantFailureCallback(payment.id, checkout, 1032);
      h.fake.queries.set(checkout, { done: true, resultCode: 1032 });
      await h.owner(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [h.A()]);
      try {
        expect(await h.cycle()).toEqual([]); // school suspension rule unchanged: waits, not cancelled
        expect((await h.jobOf(payment.id))!.status).toBe("queued");
      } finally {
        await h.owner(`UPDATE tenants SET status = 'active' WHERE id = $1`, [h.A()]);
      }
      await h.owner(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [h.ids.orgA]);
      try {
        expect(await h.cycle()).toEqual(["succeeded"]); // §6: a system job follows its school's state, not the organisation's
      } finally {
        await h.owner(`UPDATE organizations SET status = 'active' WHERE id = $1`, [h.ids.orgA]);
      }
      expect((await h.payment(payment.id)).status).toBe("cancelled");
    });
  });

  describe("worker audit attribution", () => {
    it("a successful job writes job.succeeded with job, tenant, attempt and no user actor", async () => {
      const { inv, payment, checkout, job } = await dueJob();
      h.fake.queries.set(checkout, { done: true, resultCode: 0 });
      expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: "B1SUCCESS1" }))).statusCode).toBe(200);
      expect(await h.cycle()).toEqual(["succeeded"]); // already settled by the callback: handler no-op
      const events = (await h.auditOf("job.succeeded")).filter((e) => e.detail.jobId === job.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.actor_user_id).toBeNull();
      expect(events[0]!.tenant_id).toBe(h.A());
      expect(events[0]!.detail).toMatchObject({ jobId: job.id, jobType: "mpesa.stk_settle", attempt: 1, actingVia: "worker", outcome: "succeeded", enqueuedByUserId: null });
      expect((await h.invoice(inv)).paid_minor).toBe(100_000);
      expect((await h.payment(payment.id)).status).toBe("success");
    });

    it("a settlement by the worker is audited with the job's attribution; a callback settlement is not claimed as the worker's", async () => {
      const w = await dueJob();
      await h.plantFailureCallback(w.payment.id, w.checkout, 1032);
      h.fake.queries.set(w.checkout, { done: true, resultCode: 1032 });
      expect(await h.cycle()).toEqual(["succeeded"]);
      const settled = (await h.auditOf("finance.mpesa.settled")).find((e) => e.detail.paymentId === w.payment.id)!;
      expect(settled.actor_user_id).toBeNull();
      expect(settled.detail).toMatchObject({ actingVia: "worker", source: "status_query", jobId: w.job.id, jobType: "mpesa.stk_settle", attempt: 1, outcome: "cancelled" });

      const c = await dueJob();
      h.fake.queries.set(c.checkout, { done: true, resultCode: 0 });
      expect((await h.sendCallback(h.callbackBody(c.checkout, 0, { receipt: "B1CALLBACK" }))).statusCode).toBe(200);
      const viaCallback = (await h.auditOf("finance.mpesa.settled")).find((e) => e.detail.paymentId === c.payment.id)!;
      expect(viaCallback.detail).toMatchObject({ actingVia: "callback", source: "callback" });
      expect(viaCallback.detail.jobId).toBeUndefined();
    });

    it("retry and dead-letter events carry the same attribution and no user actor", async () => {
      const { payment, checkout, job } = await dueJob();
      h.fake.queries.set(checkout, "throw");
      expect(await h.cycle()).toEqual(["retry"]);
      const retry = (await h.auditOf("job.retry_scheduled")).find((e) => e.detail.jobId === job.id)!;
      expect(retry.actor_user_id).toBeNull();
      expect(retry.detail).toMatchObject({ jobType: "mpesa.stk_settle", attempt: 1, errorCode: "provider_error", actingVia: "worker", outcome: "retry" });
      await h.owner(`UPDATE jobs SET max_attempts = 1, attempts = 0, run_after = now() - interval '1 second' WHERE id = $1`, [job.id]);
      expect(await h.cycle()).toEqual(["dead"]);
      const dead = (await h.auditOf("job.dead")).find((e) => e.detail.jobId === job.id)!;
      expect(dead.detail).toMatchObject({ reason: "max_attempts", actingVia: "worker", errorCode: "provider_error", attempt: 1 });
      expect((await h.payment(payment.id)).status).toBe("pending");
    });

    it("a dead-letter by lease exhaustion is audited exactly once, with its reason and attempt", async () => {
      const { job } = await dueJob();
      await h.owner(
        `UPDATE jobs SET status = 'leased', attempts = max_attempts, leased_by = 'crashed', lease_token = 'crashed', lease_started_at = now(), lease_expires_at = now() - interval '1 minute',
                run_after = now() - interval '1 hour', last_error_code = 'provider_error' WHERE id = $1`,
        [job.id],
      );
      expect(await h.cycle()).toEqual([]); // the claim dead-letters it; nothing runs
      expect(await h.cycle()).toEqual([]);
      const events = (await h.auditOf("job.dead")).filter((e) => e.detail.jobId === job.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.actor_user_id).toBeNull();
      expect(events[0]!.detail).toMatchObject({ reason: "lease_exhausted", attempt: 8, errorCode: "provider_error", actingVia: "worker", jobType: "mpesa.stk_settle" });
      expect((await h.jobOf((job.payload as Json).paymentId))!.status).toBe("dead");
    });
  });

  describe("lease safety (fencing token = attempts)", () => {
    const stealing = (paymentId: string, mode: "succeed" | "fail", reclaimByName?: string) => ({
      "mpesa.stk_settle": async () => {
        if (reclaimByName) {
          // the lease expires and the SAME worker name claims it again: attempts moves to 2
          await h.owner(`UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE idempotency_key = $1`, [`settle:${paymentId}`]);
          const r = await h.workerPool.query(`SELECT attempts FROM jobs_claim($1, 30, ARRAY['mpesa.stk_settle'])`, [reclaimByName]);
          expect(r.rows[0].attempts).toBe(2);
        } else {
          await h.owner(`UPDATE jobs SET leased_by = 'another-worker', lease_token = 'another-worker', lease_started_at = now(), attempts = attempts + 1 WHERE idempotency_key = $1`, [`settle:${paymentId}`]);
        }
        if (mode === "fail") throw new RetryableJobError("provider_error");
      },
    });

    it("a stale worker cannot report success after losing the lease, and nothing false is audited", async () => {
      const { payment, job } = await dueJob();
      const out = await runCycle(h.workerPool, { workerName: "stale-1", leaseSeconds: 30, handlers: stealing(payment.id, "succeed") });
      expect(out).toBe("lease_lost");
      const after = (await h.jobOf(payment.id))!;
      expect(after.status).toBe("leased");
      expect(after.leased_by).toBe("another-worker");
      expect((await h.auditOf("job.succeeded")).filter((e) => e.detail.jobId === job.id)).toHaveLength(0);
    });

    it("a stale worker cannot schedule a retry or a dead-letter after losing the lease, and nothing false is audited", async () => {
      const { payment, job } = await dueJob();
      const out = await runCycle(h.workerPool, { workerName: "stale-2", leaseSeconds: 30, handlers: stealing(payment.id, "fail") });
      expect(out).toBe("lease_lost");
      expect((await h.jobOf(payment.id))!.status).toBe("leased");
      expect((await h.auditOf("job.retry_scheduled")).filter((e) => e.detail.jobId === job.id)).toHaveLength(0);
      const { payment: p2, job: j2 } = await dueJob();
      const perm = { "mpesa.stk_settle": async () => { await h.owner(`UPDATE jobs SET leased_by = 'x', lease_token = 'x', lease_started_at = now() WHERE idempotency_key = $1`, [`settle:${p2.id}`]); throw new PermanentJobError("invalid_payload"); } };
      expect(await runCycle(h.workerPool, { workerName: "stale-3", leaseSeconds: 30, handlers: perm })).toBe("lease_lost");
      expect((await h.auditOf("job.dead")).filter((e) => e.detail.jobId === j2.id)).toHaveLength(0);
    });

    it("the fencing token also stops a stale worker that shares its name with the new lease holder", async () => {
      const { payment, job } = await dueJob();
      const out = await runCycle(h.workerPool, { workerName: "twin", leaseSeconds: 30, handlers: stealing(payment.id, "succeed", "twin") });
      expect(out).toBe("lease_lost"); // leased_by still equals "twin", but attempts is 2, not the token (1) it holds
      const after = (await h.jobOf(payment.id))!;
      expect(after.status).toBe("leased");
      expect(after.attempts).toBe(2);
      expect((await h.auditOf("job.succeeded")).filter((e) => e.detail.jobId === job.id)).toHaveLength(0);
    });
  });

  describe("audit integrity of the worker role", () => {
    const ev = (over: Json = {}) => ({ type: "job.succeeded", tenant: h.A(), actor: null as string | null, detail: { actingVia: "worker" } as Json, ip: null as string | null, ...over });
    const insert = (c: import("pg").PoolClient, e: ReturnType<typeof ev>) =>
      c.query(`INSERT INTO security_audit_events (event_type, tenant_id, actor_user_id, detail, ip) VALUES ($1, $2, $3, $4::jsonb, $5::inet)`, [e.type, e.tenant, e.actor, JSON.stringify(e.detail), e.ip]);

    it("N-3: the worker cannot write ANY audit event directly (every shape is refused); job.* and finance.* rows come only from trusted functions", async () => {
      const results: Record<string, string | null> = {};
      const attempt = async (name: string, e: ReturnType<typeof ev>) => {
        results[name] = await h.asApp(h.A(), (c) => h.sqlState(insert(c, e)), h.workerPool);
      };
      await attempt("valid", ev());
      await attempt("otherTenant", ev({ tenant: h.ids.tenantB }));
      await attempt("noTenant", ev({ tenant: null }));
      await attempt("withActor", ev({ actor: h.ids.adminA }));
      await attempt("withIp", ev({ ip: "10.0.0.1" }));
      await attempt("notMarkedWorker", ev({ detail: { actingVia: "callback" } }));
      await attempt("noMarker", ev({ detail: {} }));
      await attempt("forgedType", ev({ type: "auth.login.success" }));
      await attempt("forgedRbacType", ev({ type: "rbac.permission.denied" }));
      expect(results).toEqual({
        valid: "42501",
        otherTenant: "42501",
        noTenant: "42501",
        withActor: "42501",
        withIp: "42501",
        notMarkedWorker: "42501",
        noMarker: "42501",
        forgedType: "42501",
        forgedRbacType: "42501",
      });
    });

    it("the API role is not restricted by the worker trigger (login, user and ip attribution keep working)", async () => {
      const code = await h.asApp(h.A(), (c) => h.sqlState(insert(c, ev({ type: "auth.login.success", actor: h.ids.adminA, detail: {}, ip: "10.0.0.2" }))));
      expect(code).toBeNull();
    });
  });

  describe("operator cancellation of a settlement job", () => {
    const cancel = (paymentId: string, reason: string, token = h.admin) => h.post(`/payments/${paymentId}/settlement-job/cancel`, { reason }, token);

    it("an administrator cancels a queued job whose payment is final; it is reasoned, audited and never runs", async () => {
      const { payment, checkout, job } = await dueJob();
      h.fake.queries.set(checkout, { done: true, resultCode: 0 });
      expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: "B1CANCEL01" }))).statusCode).toBe(200);
      const res = await cancel(payment.id, "Settled by the callback; stop the redundant check");
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().job).toEqual({ id: job.id, status: "cancelled", payment_id: payment.id });
      const after = (await h.jobOf(payment.id))!;
      expect(after).toMatchObject({ status: "cancelled", cancel_reason: "Settled by the callback; stop the redundant check" });
      const ev = (await h.auditOf("job.cancelled")).find((e) => e.detail.jobId === job.id)!;
      expect(ev.actor_user_id).toBe(h.ids.adminA);
      expect(ev.detail).toMatchObject({ actingVia: "operator", reason: "Settled by the callback; stop the redundant check", paymentStatus: "success" });
      expect(await h.cycle()).toEqual([]); // a cancelled job is never claimed
      expect((await cancel(payment.id, "Cancelling a second time for no reason")).statusCode).toBe(409); // final
    });

    it("is refused while the payment is pending: cancelling would abandon real money", async () => {
      const { payment, job } = await dueJob();
      const res = await cancel(payment.id, "Trying to drop an unsettled obligation");
      expect(res.statusCode).toBe(409);
      expect((await h.jobOf(payment.id))!.status).toBe("queued");
      expect((await h.auditOf("job.cancelled")).filter((e) => e.detail.jobId === job.id)).toHaveLength(0);
    });

    it("needs the administer permission, a reason, tenant scope, and is closed to the worker role", async () => {
      const { payment, checkout } = await dueJob();
      h.fake.queries.set(checkout, { done: true, resultCode: 0 });
      expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt: "B1AUTHZ001" }))).statusCode).toBe(200);
      await h.owner(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees') ON CONFLICT DO NOTHING`, [h.A(), h.ids.teacherA]);
      try {
        expect((await cancel(payment.id, "A fees writer must not cancel jobs", h.teacher)).statusCode).toBe(403);
      } finally {
        await h.owner(`DELETE FROM staff_area_grants WHERE user_id = $1 AND area = 'fees'`, [h.ids.teacherA]);
      }
      expect((await cancel(payment.id, "short")).statusCode).toBe(400);
      expect((await h.call("POST", h.fin(`/payments/${payment.id}/settlement-job/cancel`), h.parent, { reason: "A parent must not cancel jobs" })).statusCode).toBe(403);
      // another school's administrator cannot reach this school's job
      const otherSchool = await h.call("POST", h.fin(`/payments/${payment.id}/settlement-job/cancel`), (await h.login({ tenantId: h.ids.tenantB, loginId: "TC-0001", password: "correct-horse-battery" })), { reason: "Cross-tenant attempt to cancel" });
      expect([403, 404]).toContain(otherSchool.statusCode);
      expect((await h.jobOf(payment.id))!.status).toBe("queued");
      // the worker role cannot call the cancel function at all
      const jobId = (await h.jobOf(payment.id))!.id;
      expect(await h.asApp(h.A(), (c) => h.sqlState(c.query(`SELECT public.jobs_operator_cancel($1, $2, 'worker must not cancel this job', NULL)`, [jobId, h.ids.adminA])), h.workerPool)).toBe("42501");
    });
  });

  describe("review fixes: database-level guarantees", () => {
    const asUser = (tenant: string | null, user: string | null, fn: (c: import("pg").PoolClient) => Promise<unknown>) =>
      h.asApp(tenant, async (c) => {
        if (user) await c.query("SELECT set_config('app.user_id', $1, true)", [user]);
        return fn(c);
      });
    const cancelFn = (c: import("pg").PoolClient, jobId: string, actor: string) =>
      c.query("SELECT public.jobs_operator_cancel($1, $2, 'a long enough operator reason', NULL)", [jobId, actor]);

    async function settledWithQueuedJob() {
      const { payment, checkout, job } = await dueJob();
      h.fake.queries.set(checkout, { done: true, resultCode: 0 });
      const receipt = "R" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase();
      expect((await h.sendCallback(h.callbackBody(checkout, 0, { receipt }))).statusCode).toBe(200);
      return { payment, job };
    }

    it("jobs_operator_cancel: another tenant's context finds nothing; the actor must be the signed-in user; a tenant is required", async () => {
      const { job } = await settledWithQueuedJob();
      expect(await asUser(h.ids.tenantB, h.ids.adminA, (c) => h.sqlState(cancelFn(c, job.id, h.ids.adminA)))).toBe("P0002");
      expect(await asUser(h.A(), h.ids.adminA, (c) => h.sqlState(cancelFn(c, job.id, h.ids.teacherA)))).toBe("42501");
      expect(await asUser(h.A(), null, (c) => h.sqlState(cancelFn(c, job.id, h.ids.adminA)))).toBe("42501");
      expect(await asUser(null, h.ids.adminA, (c) => h.sqlState(cancelFn(c, job.id, h.ids.adminA)))).toBe("42501");
      expect(await asUser(h.A(), h.ids.adminA, (c) => h.sqlState(c.query("SELECT public.jobs_operator_cancel($1, $2, 'short', NULL)", [job.id, h.ids.adminA])))).toBe("22023");
      // asApp rolls back, so the legitimate call is shown to work and then leaves no trace
      expect(await asUser(h.A(), h.ids.adminA, (c) => h.sqlState(cancelFn(c, job.id, h.ids.adminA)))).toBeNull();
      expect((await h.jobOf((job.payload as Json).paymentId))!.status).toBe("queued");
    });

    it("a leased job cannot be cancelled, and a cancel that holds the row lock makes a concurrent claim skip the job", async () => {
      const { payment, job } = await settledWithQueuedJob();
      await h.owner("UPDATE jobs SET status = 'leased', attempts = 1, leased_by = 'busy', lease_token = 'busy', lease_started_at = now(), lease_expires_at = now() + interval '5 minutes' WHERE id = $1", [job.id]);
      expect((await h.post("/payments/" + payment.id + "/settlement-job/cancel", { reason: "Trying to cancel a leased job" })).statusCode).toBe(409);
      await h.owner("UPDATE jobs SET status = 'queued', lease_expires_at = NULL, leased_by = NULL, attempts = 0, run_after = now() - interval '1 second' WHERE id = $1", [job.id]);
      // the cancel holds the row lock inside an open transaction; SKIP LOCKED must pass the job over
      const holder = await h.ctx.runtimePool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [h.A(), h.ids.adminA]);
        await cancelFn(holder, job.id, h.ids.adminA);
        const claimed = await h.workerPool.query("SELECT id FROM jobs_claim('racer', 30, ARRAY['mpesa.stk_settle']) WHERE id = $1", [job.id]);
        expect(claimed.rowCount).toBe(0);
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }
      expect((await h.jobOf(payment.id))!.status).toBe("cancelled");
      expect(await h.cycle()).toEqual([]);
    });

    it("a malformed job payload is a 409 conflict on cancel, never a 500", async () => {
      const fakePayment = randomUUID();
      await h.owner(
        "INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after) VALUES ($1, 'mpesa.stk_settle', '{\"paymentId\":\"not-a-uuid\"}'::jsonb, $2, now() + interval '1 day')",
        [h.A(), "settle:" + fakePayment],
      );
      const res = await h.post("/payments/" + fakePayment + "/settlement-job/cancel", { reason: "Malformed payload job to cancel" });
      expect(res.statusCode).toBe(409);
    });

    it("the cancel route records the caller's IP and counts reason length in code points", async () => {
      const { payment, job } = await settledWithQueuedJob();
      const astral = "\u{1F600}".repeat(10); // 10 code points, 20 UTF-16 units: valid
      const res = await h.post("/payments/" + payment.id + "/settlement-job/cancel", { reason: astral });
      expect(res.statusCode, res.body).toBe(200);
      const ev = (await h.owner("SELECT ip FROM security_audit_events WHERE event_type = 'job.cancelled' AND detail->>'jobId' = $1", [job.id]))[0]!;
      expect(ev.ip).not.toBeNull();
    });

    it("the worker ROLE itself cannot cancel a job, rewrite the fencing token, or touch a job it has not leased", async () => {
      const { payment, job } = await dueJob();
      const w = (sql: string, params: unknown[] = []) => h.asApp(h.A(), (c) => h.sqlState(c.query(sql, params)), h.workerPool);
      // queued job: any worker UPDATE is refused (it may act only on a leased job)
      expect(await w("UPDATE jobs SET run_after = now() WHERE id = $1", [job.id])).toBe("42501");
      expect(await w("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [job.id])).toBe("42501");
      expect(await w("UPDATE jobs SET cancel_reason = 'forged cancellation reason' WHERE id = $1", [job.id])).toBe("42501");
      expect(await w("UPDATE jobs SET attempts = 0 WHERE id = $1", [job.id])).toBe("42501");
      // F8-A (migration 061): even on a leased job, direct worker UPDATE is privilege-denied (42501);
      // transitions go exclusively through the lease-bound SECURITY DEFINER functions.
      await h.owner("UPDATE jobs SET status = 'leased', attempts = 3, leased_by = 'w', lease_token = 'w', lease_started_at = now(), lease_expires_at = now() + interval '5 minutes' WHERE id = $1", [job.id]);
      expect(await w("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [job.id])).toBe("42501");
      expect(await w("UPDATE jobs SET attempts = 0 WHERE id = $1", [job.id])).toBe("42501");
      expect(await w("UPDATE jobs SET status = 'queued', run_after = now(), lease_expires_at = NULL, leased_by = NULL WHERE id = $1", [job.id])).toBe("42501");
      expect(await w("SELECT public.jobs_retry($1, 'w', 3, 15, 'provider_error')", [job.id])).toBeNull();
      expect((await h.jobOf(payment.id))!.attempts).toBe(3);
    });

    it("N-3: the worker cannot insert an audit row with a chosen id or time (INSERT privilege itself is revoked)", async () => {
      const code = await h.asApp(h.A(), (c) =>
        h.sqlState(
          c.query("INSERT INTO security_audit_events (id, occurred_at, event_type, tenant_id, detail) VALUES ($1, '2001-01-01T00:00:00Z', 'job.succeeded', $2, $3::jsonb)", [
            randomUUID(),
            h.A(),
            JSON.stringify({ actingVia: "worker" }),
          ]),
        ),
        h.workerPool,
      );
      expect(code).toBe("42501");
    });
  });

  describe("review fixes: suspended schools and fenced side effects", () => {
    it("an exhausted expired lease of a SUSPENDED school is neither dead-lettered nor audited until the school is restored", async () => {
      const { payment, job } = await dueJob();
      await h.owner(
        "UPDATE jobs SET status = 'leased', attempts = max_attempts, leased_by = 'crashed', lease_token = 'crashed', lease_started_at = now(), lease_expires_at = now() - interval '1 minute', last_error_code = 'provider_error' WHERE id = $1",
        [job.id],
      );
      await h.owner("UPDATE tenants SET status = 'suspended' WHERE id = $1", [h.A()]);
      try {
        expect(await h.cycle()).toEqual([]);
        expect((await h.jobOf(payment.id))!.status).toBe("leased");
        expect((await h.auditOf("job.dead")).filter((e) => e.detail.jobId === job.id)).toHaveLength(0);
      } finally {
        await h.owner("UPDATE tenants SET status = 'active' WHERE id = $1", [h.A()]);
      }
      expect(await h.cycle()).toEqual([]);
      expect((await h.jobOf(payment.id))!.status).toBe("dead");
      expect((await h.auditOf("job.dead")).filter((e) => e.detail.jobId === job.id)).toHaveLength(1);
    });

    it("a worker that loses its lease before settling cannot move the payment or write the settlement audit", async () => {
      const { payment } = await dueJob();
      const handlers = {
        "mpesa.stk_settle": async (ctx: import("../src/worker/runtime.js").JobContext) => {
          await h.owner("UPDATE jobs SET leased_by = 'another-worker', lease_token = 'another-worker', lease_started_at = now(), attempts = attempts + 1 WHERE id = $1", [ctx.jobId]); // the lease moves
          await ctx.fenced((tx) =>
            settlePrompt(tx, {
              tenantId: ctx.tenantId,
              paymentId: payment.id,
              source: "status_query",
              query: { done: true, resultCode: 1032 },
              job: { jobId: ctx.jobId, jobType: ctx.jobType, attempt: ctx.attempt, leaseToken: ctx.leaseToken },
            }),
          );
        },
      };
      expect(await runCycle(h.workerPool, { workerName: "stale-settler", leaseSeconds: 30, handlers })).toBe("lease_lost");
      expect((await h.payment(payment.id)).status).toBe("pending");
      expect((await h.auditOf("finance.mpesa.settled")).filter((e) => e.detail.paymentId === payment.id)).toHaveLength(0);
      expect(await h.owner("SELECT 1 FROM finance_mpesa_events WHERE payment_id = $1", [payment.id])).toHaveLength(0);
    });
  });
});
