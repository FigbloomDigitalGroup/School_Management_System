import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setLogSink } from "../src/log.js";
import { junkBucketAddress } from "../src/http/routes/mpesa.js";
import { CALLBACK_SECRET, financeHarness, type Json } from "./support/financeHarness.js";

/**
 * Remediation batch 6: the M-Pesa callback has its OWN throttling policy.
 *   * the URL secret is checked FIRST (no database), so junk can never starve legitimate provider callbacks;
 *   * wrong-secret traffic drains only a per-address bucket of its own;
 *   * authenticated callbacks share a burst-sized platform bucket whose refusals are observable (429 + Retry-After + a log event);
 *   * proxy trust decides the address used for the junk bucket; it never decides whether a legitimate callback is accepted;
 *   * the secret never appears in a log line.
 * Provider-level retry behaviour is NOT verified here (no sandbox): see the remediation record.
 */
describe("Stage 11 remediation batch 6: callback throttling", () => {
  const h = financeHarness();
  const extra: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of extra) await a.close().catch(() => undefined);
  });
  beforeEach(async () => {
    await h.owner("DELETE FROM auth_rate_buckets WHERE bucket_key LIKE 'mpesa_callback%'");
  });

  const base = () => ({
    ...h.ctx.config,
    mpesaCallbackSecret: CALLBACK_SECRET,
    mpesaCallbackUrl: "http://localhost/v1/mpesa/callback",
    mpesaSettleDelaySeconds: 120,
  });
  async function appWith(over: Json = {}): Promise<FastifyInstance> {
    const a = await buildApp({ ...base(), ...over } as never, h.ctx.runtimePool, { mpesaProvider: h.fake });
    await a.ready();
    extra.push(a);
    return a;
  }
  /** A callback for a checkout id nobody knows: the cheapest authenticated request (quarantined, answered 200). */
  const unknownBody = () => h.callbackBody("ws_CO_THROTTLE_" + randomUUID().slice(0, 8), 0, { receipt: "R" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase(), amount: 1000 });
  const post = (a: FastifyInstance, ip: string, token: string | null, headers: Json = {}, body: unknown = unknownBody()) =>
    a.inject({
      method: "POST",
      url: `/v1/mpesa/callback${token === null ? "" : `?token=${encodeURIComponent(token)}`}`,
      payload: body as Json,
      remoteAddress: ip,
      headers,
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("ships its own typed policies with the documented defaults, distinct from the login limit", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgresql://figbloom_app@127.0.0.1/figbloom_api" } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({
      mpesaCallbackRateCapacity: 200,
      mpesaCallbackRateRefill: 100,
      mpesaCallbackRateIntervalMs: 1000,
      mpesaCallbackInvalidRateCapacity: 10,
      mpesaCallbackInvalidRateRefill: 2,
      mpesaCallbackInvalidRateIntervalMs: 5000,
    });
    expect(cfg.mpesaCallbackRateCapacity).toBeGreaterThan(cfg.authRateCapacity); // the callback is not a login
    const tuned = loadConfig({ DATABASE_URL: "postgresql://figbloom_app@127.0.0.1/figbloom_api", MPESA_CALLBACK_RATE_CAPACITY: "50", MPESA_CALLBACK_INVALID_RATE_CAPACITY: "3" } as NodeJS.ProcessEnv);
    expect(tuned).toMatchObject({ mpesaCallbackRateCapacity: 50, mpesaCallbackInvalidRateCapacity: 3 });
  });

  it("unauthenticated junk and wrong secrets are bounded per address, and a LEGITIMATE callback from the same address is never starved", async () => {
    const a = await appWith(); // production-default callback policy (the suite's login limit is irrelevant here)
    const junk: number[] = [];
    for (let i = 0; i < 14; i++) junk.push((await post(a, "198.51.100.7", i % 2 ? null : "wrong-" + i)).statusCode);
    expect(junk.slice(0, 10).every((c) => c === 403)).toBe(true); // the first ten are refused as forbidden
    expect(junk.slice(10).every((c) => c === 429)).toBe(true); // then the junk bucket is empty
    // ...yet the provider's real callback from the SAME address, right now, is accepted
    const legit = await post(a, "198.51.100.7", CALLBACK_SECRET);
    expect(legit.statusCode, legit.body).toBe(200);
    // and a junk sender at a different address is unaffected by the first one's exhaustion
    expect((await post(a, "198.51.100.8", "wrong")).statusCode).toBe(403);
  });

  it("a burst of valid callbacks is accepted up to the platform bucket, then refused with 429 + Retry-After and an observable, secret-free log event", async () => {
    const a = await appWith({ mpesaCallbackRateCapacity: 3, mpesaCallbackRateRefill: 1, mpesaCallbackRateIntervalMs: 3_600_000 });
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await post(a, "203.0.113.20", CALLBACK_SECRET)).statusCode);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
      const refused = await post(a, "203.0.113.20", CALLBACK_SECRET);
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      // junk is not throttled by an exhausted authenticated bucket: it still gets its own answer
      expect((await post(a, "203.0.113.21", "wrong")).statusCode).toBe(403);
    } finally {
      restore();
    }
    const events = lines.map((l) => JSON.parse(l) as Json);
    expect(events.filter((e) => e.msg === "mpesa_callback_rate_limited" && e.outcome === "authenticated").length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.msg === "mpesa_callback_rejected" && e.outcome === "bad_secret")).toBe(true);
  });

  it("a refused callback can be retried once the bucket refills; a redelivery of a settled callback is idempotent", async () => {
    const a = await appWith({ mpesaCallbackRateCapacity: 2, mpesaCallbackRateRefill: 2, mpesaCallbackRateIntervalMs: 300 });
    expect((await post(a, "203.0.113.30", CALLBACK_SECRET)).statusCode).toBe(200);
    expect((await post(a, "203.0.113.30", CALLBACK_SECRET)).statusCode).toBe(200);
    expect((await post(a, "203.0.113.30", CALLBACK_SECRET)).statusCode).toBe(429);
    await sleep(700); // the provider (or its retry) comes back
    expect((await post(a, "203.0.113.30", CALLBACK_SECRET)).statusCode).toBe(200);
    // a real prompt: the first delivery credits, the retry changes nothing
    const inv = await h.freshInvoice(1_000_000);
    const { payment, checkout } = await h.startPrompt(inv, 100_000);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const body = h.callbackBody(checkout, 0, { receipt: "R" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase(), amount: 1000 });
    await h.owner("DELETE FROM auth_rate_buckets WHERE bucket_key LIKE 'mpesa_callback%'"); // a fresh bucket for the default policy
    const b = await appWith();
    expect((await post(b, "203.0.113.31", CALLBACK_SECRET, {}, body)).statusCode).toBe(200);
    expect((await post(b, "203.0.113.31", CALLBACK_SECRET, {}, body)).statusCode).toBe(200);
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
    expect((await h.payment(payment.id)).status).toBe("success");
  });

  it("proxy trust decides the address of the JUNK bucket: a trusted proxy's forwarded address is honoured, an untrusted peer cannot forge one", async () => {
    const a = await appWith({ trustProxyHops: 1, trustProxyCidrs: ["198.51.100.0/24"] });
    // trusted proxy peer: each forwarded client gets its own junk bucket, so 14 different clients are never throttled
    const trusted: number[] = [];
    for (let i = 0; i < 14; i++) trusted.push((await post(a, "198.51.100.10", "wrong", { "x-forwarded-for": `203.0.113.${100 + i}` })).statusCode);
    expect(trusted.every((c) => c === 403)).toBe(true);
    // untrusted peer forging X-Forwarded-For: the header is ignored, the socket address is the bucket, and it trips
    const forged: number[] = [];
    for (let i = 0; i < 12; i++) forged.push((await post(a, "203.0.113.200", "wrong", { "x-forwarded-for": `198.51.100.${i + 1}` })).statusCode);
    expect(forged.slice(0, 10).every((c) => c === 403)).toBe(true);
    expect(forged[10]).toBe(429);
    // a legitimate callback through the trusted proxy is accepted regardless
    expect((await post(a, "198.51.100.10", CALLBACK_SECRET, { "x-forwarded-for": "203.0.113.150" })).statusCode).toBe(200);
  });

  it("with proxy trust missing or misconfigured, junk from MANY clients shares one bucket, but legitimate callbacks are never affected", async () => {
    const a = await appWith({ trustProxyHops: 0, trustProxyCidrs: [] }); // behind a load balancer, trust not configured
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post(a, "10.0.0.5", "wrong", { "x-forwarded-for": `203.0.113.${i + 1}` })).statusCode);
    expect(codes.slice(10)).toEqual([429, 429]); // every client looks like the load balancer: one shared junk bucket
    for (let i = 0; i < 5; i++) expect((await post(a, "10.0.0.5", CALLBACK_SECRET, { "x-forwarded-for": `203.0.113.${i + 1}` })).statusCode).toBe(200); // the legitimate bucket is separate
  });

  it("the callback secret never appears in a log line (accepted, refused, throttled, quarantined)", async () => {
    const a = await appWith({ mpesaCallbackRateCapacity: 1, mpesaCallbackRateRefill: 1, mpesaCallbackRateIntervalMs: 3_600_000 });
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    try {
      await post(a, "203.0.113.40", CALLBACK_SECRET); // accepted (quarantined)
      await post(a, "203.0.113.40", CALLBACK_SECRET); // throttled
      await post(a, "203.0.113.41", "a-wrong-secret-value-0123456789"); // refused
      await post(a, "203.0.113.42", null); // no secret at all
    } finally {
      restore();
    }
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).not.toContain(CALLBACK_SECRET);
    expect(all).not.toContain("a-wrong-secret-value-0123456789");
    expect(all).not.toMatch(/token=/i);
  });

  it("legitimate callbacks continue to settle while junk is being thrown at the endpoint", async () => {
    const a = await appWith();
    const inv = await h.freshInvoice(1_000_000);
    const { payment, checkout } = await h.startPrompt(inv, 100_000);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const rcpt = "R" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase();
    const junk = Promise.all(Array.from({ length: 40 }, (_, i) => post(a, "192.0.2.77", "junk-" + i)));
    const legit = post(a, "192.0.2.78", CALLBACK_SECRET, {}, h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 }));
    const [, res] = await Promise.all([junk, legit]);
    expect(res.statusCode, res.body).toBe(200);
    expect(await h.payment(payment.id)).toMatchObject({ status: "success", mpesa_receipt: rcpt });
  });

  it("refuses callback limits that would silently break callbacks or switch the limit off (startup validation)", () => {
    const env = (o: Record<string, string>) => ({ DATABASE_URL: "postgresql://figbloom_app@127.0.0.1/figbloom_api", ...o }) as NodeJS.ProcessEnv;
    const bads: Array<Record<string, string>> = [
      { MPESA_CALLBACK_RATE_CAPACITY: "0.5" },
      { MPESA_CALLBACK_RATE_CAPACITY: "1" },
      { MPESA_CALLBACK_RATE_CAPACITY: "0" },
      { MPESA_CALLBACK_RATE_CAPACITY: "100000000" },
      { MPESA_CALLBACK_RATE_REFILL: "0" },
      { MPESA_CALLBACK_RATE_REFILL: "1.5" },
      { MPESA_CALLBACK_RATE_INTERVAL_MS: "5" },
      { MPESA_CALLBACK_INVALID_RATE_CAPACITY: "0" },
      { MPESA_CALLBACK_INVALID_RATE_CAPACITY: "100000" },
      { MPESA_CALLBACK_INVALID_RATE_INTERVAL_MS: "99999999999" },
    ];
    for (const bad of bads) expect(() => loadConfig(env(bad)), JSON.stringify(bad)).toThrow();
    expect(() => loadConfig(env({ MPESA_CALLBACK_RATE_CAPACITY: "2", MPESA_CALLBACK_INVALID_RATE_CAPACITY: "1" }))).not.toThrow();
  });

  it("IPv6 junk senders are accounted per /64 (not per address); IPv4 and unknown addresses are unchanged", async () => {
    expect(junkBucketAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(junkBucketAddress(null)).toBeNull();
    expect(junkBucketAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(junkBucketAddress("2001:db8:1:2::1"));
    expect(junkBucketAddress("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(junkBucketAddress("2001:db8:1:3::1")).not.toBe(junkBucketAddress("2001:db8:1:2::1"));
    const a = await appWith();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post(a, `2001:db8:9:9::${i + 1}`, "wrong")).statusCode); // twelve addresses, one /64
    expect(codes.slice(0, 10).every((c) => c === 403)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    expect((await post(a, "2001:db8:9:a::1", "wrong")).statusCode).toBe(403); // another /64 is a different sender
  });

  it("a junk 429 carries Retry-After; duplicate token parameters are treated as junk", async () => {
    const a = await appWith({ mpesaCallbackInvalidRateCapacity: 1, mpesaCallbackInvalidRateRefill: 1, mpesaCallbackInvalidRateIntervalMs: 3_600_000 });
    expect((await post(a, "198.51.100.90", "wrong")).statusCode).toBe(403);
    const limited = await post(a, "198.51.100.90", "wrong");
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const dup = await a.inject({ method: "POST", url: `/v1/mpesa/callback?token=${CALLBACK_SECRET}&token=other`, payload: unknownBody() as Json, remoteAddress: "198.51.100.91" });
    expect(dup.statusCode).toBe(403);
  });

  it("two API instances share one authenticated bucket: the limit holds across instances", async () => {
    const a = await appWith({ mpesaCallbackRateCapacity: 4, mpesaCallbackRateRefill: 1, mpesaCallbackRateIntervalMs: 3_600_000 });
    const b = await appWith({ mpesaCallbackRateCapacity: 4, mpesaCallbackRateRefill: 1, mpesaCallbackRateIntervalMs: 3_600_000 });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post(i % 2 ? a : b, "203.0.113.60", CALLBACK_SECRET)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429, 429]);
  });

  it("DOCUMENTED RESIDUAL: a valid callback refused with 429 BEFORE its evidence is saved leaves the prompt pending; an operator resolves it from the provider's answer", async () => {
    const a = await appWith({ mpesaCallbackRateCapacity: 2, mpesaCallbackRateRefill: 1, mpesaCallbackRateIntervalMs: 3_600_000 });
    const inv = await h.freshInvoice(1_000_000);
    const { payment, checkout } = await h.startPrompt(inv, 100_000);
    h.fake.queries.set(checkout, { done: true, resultCode: 0 });
    const rcpt = "R" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase();
    await post(a, "203.0.113.70", CALLBACK_SECRET); // two unrelated callbacks use the burst
    await post(a, "203.0.113.70", CALLBACK_SECRET);
    const refused = await post(a, "203.0.113.70", CALLBACK_SECRET, {}, h.callbackBody(checkout, 0, { receipt: rcpt, amount: 1000 }));
    expect(refused.statusCode).toBe(429); // refused before anything about this prompt was read or stored
    expect(await h.payment(payment.id)).toMatchObject({ status: "pending", mpesa_receipt: null });
    expect(await h.owner("SELECT 1 FROM finance_mpesa_events WHERE payment_id = $1", [payment.id])).toHaveLength(0); // no evidence exists
    // nothing is lost: the money is confirmed by the provider, and a finance administrator settles it with the receipt from the statement
    const fix = await h.post(`/payments/${payment.id}/mpesa-reconciliation`, { action: "settle_success", receipt: rcpt, note: "Callback was throttled; receipt taken from the M-Pesa statement" });
    expect(fix.json()).toMatchObject({ outcome: "settled_success", payment: { status: "success", mpesa_receipt: rcpt } });
    expect(await h.invoice(inv)).toMatchObject({ paid_minor: 100_000 });
  });
});
