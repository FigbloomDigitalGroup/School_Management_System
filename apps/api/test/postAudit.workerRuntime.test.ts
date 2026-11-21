import { describe, expect, it } from "vitest";
import { LeaseLostError, PermanentJobError, RetryableJobError, runCycle, type JobHandler } from "../src/worker/runtime.js";
import { financeHarness } from "./support/financeHarness.js";

/** Worker runtime (audit Phase 7): lease token plumbing, bounded renewal, lost lease, retry/dead, restart — through runCycle. */
describe("post-audit: worker runtime with lease tokens", () => {
  const h = financeHarness();

  async function dueJob(): Promise<{ paymentId: string; key: string }> {
    const inv = await h.freshInvoice(1_000_000);
    const p = await h.startPrompt(inv, 100_000);
    const key = `settle:${p.payment.id}`;
    await h.owner(`UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued' AND idempotency_key <> $1`, [key]);
    await h.makeDue(p.payment.id);
    return { paymentId: p.payment.id as string, key };
  }
  const cycle = (handler: JobHandler, leaseSeconds = 30) =>
    runCycle(h.workerPool, { workerName: "rt-worker", leaseSeconds, handlers: { "mpesa.stk_settle": handler }, random: () => 0 });
  const job = async (key: string) => (await h.owner(`SELECT status, attempts, lease_token, leased_by, lease_expires_at, last_error_code FROM jobs WHERE idempotency_key = $1`, [key]))[0]!;

  it("a handler can renew its lease (bounded) and the job then completes; the token is cleared on completion", async () => {
    const { key } = await dueJob();
    let before = 0;
    let after = 0;
    const out = await cycle(async (ctx) => {
      before = new Date((await h.owner(`SELECT lease_expires_at FROM jobs WHERE id = $1`, [ctx.jobId]))[0]!.lease_expires_at).getTime();
      await ctx.extendLease(120);
      after = new Date((await h.owner(`SELECT lease_expires_at FROM jobs WHERE id = $1`, [ctx.jobId]))[0]!.lease_expires_at).getTime();
      expect(ctx.leaseToken).toMatch(/^[0-9a-f]{64}$/);
    });
    expect(out).toBe("succeeded");
    expect(after).toBeGreaterThan(before);
    expect(await job(key)).toMatchObject({ status: "succeeded", lease_token: null, leased_by: null });
  });

  it("renewal past the maximum lease duration is refused as a lost lease; the job is not completed by that worker", async () => {
    const { key } = await dueJob();
    const out = await cycle(async (ctx) => {
      await ctx.extendLease(3600); // to the cap
      await ctx.extendLease(3600); // beyond it: LeaseLostError
    }, 60);
    expect(out === "lease_lost" || out === "retry").toBe(true);
    const j = await job(key);
    expect(j.status).not.toBe("succeeded");
  });

  it("a lease that expires mid-handler is detected by the fence; the stale worker cannot finish; a restarted worker reclaims with a NEW token", async () => {
    const { key } = await dueJob();
    let firstToken = "";
    const out = await cycle(async (ctx) => {
      firstToken = ctx.leaseToken;
      await h.owner(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [ctx.jobId]); // the worker "stalled" past its lease
      await ctx.fenced(async () => undefined); // throws LeaseLostError
    });
    expect(out).toBe("lease_lost");
    expect((await job(key)).status).toBe("leased"); // nobody finished it
    // restart: another worker process claims it after expiry with a new, different token
    let secondToken = "";
    const again = await cycle(async (ctx) => {
      secondToken = ctx.leaseToken;
    });
    expect(again).toBe("succeeded");
    expect(secondToken).toMatch(/^[0-9a-f]{64}$/);
    expect(secondToken).not.toBe(firstToken);
    expect((await job(key)).attempts).toBe(2);
  });

  it("retryable errors back off and clear the token; a permanent error dead-letters; both are audited by the trusted functions", async () => {
    const r = await dueJob();
    expect(await cycle(async () => { throw new RetryableJobError("provider_pending"); })).toBe("retry");
    expect(await job(r.key)).toMatchObject({ status: "queued", lease_token: null, last_error_code: "provider_pending" });
    const d = await dueJob();
    expect(await cycle(async () => { throw new PermanentJobError("bad_payload"); })).toBe("dead");
    expect(await job(d.key)).toMatchObject({ status: "dead", lease_token: null, last_error_code: "bad_payload" });
    const ev = (await h.auditOf("job.dead")).filter((e) => e.detail.errorCode === "bad_payload");
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0]!.detail).toMatchObject({ actingVia: "worker", reason: "permanent_error" });
  });

  it("LeaseLostError is exported for handlers", () => {
    expect(new LeaseLostError()).toBeInstanceOf(Error);
  });
});
