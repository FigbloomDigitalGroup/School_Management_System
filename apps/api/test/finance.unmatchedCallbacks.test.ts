import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { financeHarness, PASSWORD } from "./support/financeHarness.js";

/**
 * Workstream 2: unmatched provider callbacks are managed CASES (migration 074). Provider evidence stays authoritative: nothing
 * here credits money, settles or fails a payment, or fabricates evidence. Resolution needs reason AND evidence; contradictory
 * late evidence is preserved and reopens a resolved case; identical repeats only count; the worker re-evaluates and escalates.
 */
describe("unmatched-callback operator reconciliation (migration 074)", () => {
  const h = financeHarness();
  const B = "/v1/platform/finance/unmatched-callbacks";
  let su: string;
  let suId: string;
  const op = async (method: "GET" | "POST", path: string, payload?: unknown, token?: string) => h.call(method, `${B}${path}`, token ?? su, payload);
  const checkoutId = () => "ws_CO_UM_" + randomUUID().replace(/-/g, "").slice(0, 12);
  const receipt = () => "UM" + randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const cb = (checkout: string, code: number, extra: { amount?: number; receipt?: string } = {}) =>
    h.sendCallback(h.callbackBody(checkout, code, { amount: extra.amount ?? 100, receipt: extra.receipt ?? receipt() }));
  const caseOf = async (checkout: string) => (await h.owner(`SELECT * FROM finance_unmatched_cases WHERE checkout_request_id = $1`, [checkout]))[0]!;
  const evidenceOf = (id: string) => h.owner(`SELECT * FROM finance_mpesa_unmatched_callbacks WHERE case_id = $1 ORDER BY received_at`, [id]);
  const auditOf = (type: string) => h.owner(`SELECT actor_user_id, tenant_id, detail::text AS detail, detail AS d FROM security_audit_events WHERE event_type = $1 ORDER BY occurred_at, id`, [type]);
  async function workerTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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
  }
  async function unmatched(code = 0) {
    const checkout = checkoutId();
    expect((await cb(checkout, code)).statusCode).toBe(200);
    const c = await caseOf(checkout);
    return { checkout, id: c.id as string };
  }
  async function superLogin() {
    if (su) return;
    const r = await h.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "super@example.com", password: PASSWORD } });
    su = r.json().token as string;
    suId = h.ids.superAdmin;
  }

  it("an unmatched callback becomes ONE open case; an identical repeat only counts; evidence is verbatim provider fields with a masked phone", async () => {
    await superLogin();
    const checkout = checkoutId();
    const rc = receipt();
    expect((await cb(checkout, 0, { receipt: rc })).statusCode).toBe(200);
    const first = await caseOf(checkout);
    expect(first).toMatchObject({ status: "open", occurrences: 1, contradictory: false, reopened_count: 0, owner_user_id: null });
    // same payload five times in parallel, exactly the same evidence
    const body = h.callbackBody(checkout, 0, { amount: 100, receipt: rc });
    await Promise.all(Array.from({ length: 5 }, () => h.sendCallback(body)));
    const again = await caseOf(checkout);
    expect(again.occurrences).toBe(6);
    expect(await evidenceOf(first.id)).toHaveLength(1);
    expect((await evidenceOf(first.id))[0]).toMatchObject({ receipt: rc, msisdn_masked: "254*****5678" });
    // a forged or secret-less callback is refused before anything is stored
    const before = (await h.owner(`SELECT count(*)::int AS n FROM finance_unmatched_cases`))[0]!.n;
    expect((await h.sendCallback(h.callbackBody(checkoutId(), 0), "wrong-secret-wrong-secret-wrong-secret")).statusCode).toBe(403);
    expect((await h.owner(`SELECT count(*)::int AS n FROM finance_unmatched_cases`))[0]!.n).toBe(before);
  });

  it("only platform operators can list, inspect or act; unauthenticated callers are refused; the database refuses too", async () => {
    await superLogin();
    const c = await unmatched();
    for (const [method, path, payload] of [
      ["GET", "", undefined],
      ["GET", `/${c.id}`, undefined],
      ["POST", `/${c.id}/assign`, { owner_user_id: null }],
      ["POST", `/${c.id}/notes`, { note: "should not work" }],
      ["POST", `/${c.id}/retry`, undefined],
      ["POST", `/${c.id}/escalate`, { reason: "nope nope" }],
      ["POST", `/${c.id}/resolve`, { resolution: "other_evidenced", reason: "long enough reason", evidence: "long enough evidence" }],
      ["POST", `/${c.id}/reopen`, { reason: "long enough reason" }],
    ] as const) {
      for (const tok of [h.admin, h.teacher, h.parent]) expect((await op(method, path, payload, tok)).statusCode, `${method} ${path}`).toBe(403);
      expect((await h.ctx.app.inject({ method, url: `${B}${path}`, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) })).statusCode, `${method} ${path} anon`).toBe(401);
    }
    // a caller that is not an operator cannot reach the function even with a forged context
    await expect(h.asApp(h.A(), (cl) => cl.query(`SELECT * FROM public.finance_unmatched_list(NULL, NULL, false, NULL, NULL, 10)`))).rejects.toMatchObject({ code: "42501" });
    // the evidence ledger and the cases are owner-only
    await expect(h.asApp(null, (cl) => cl.query(`SELECT 1 FROM public.finance_unmatched_cases`))).rejects.toMatchObject({ code: "42501" });
  });

  it("listing filters by status, owner, unassigned, age and severity; inspection shows evidence and notes without sensitive detail", async () => {
    await superLogin();
    const high = await unmatched(0);
    const normal = await unmatched(1032);
    await h.owner(`UPDATE finance_unmatched_cases SET first_seen_at = now() - interval '3 hours' WHERE id = $1`, [high.id]);
    const ids = (r: { json: () => Record<string, any> }) => (r.json().cases as { id: string }[]).map((x) => x.id);
    expect(ids(await op("GET", "?severity=high"))).toContain(high.id);
    expect(ids(await op("GET", "?severity=high"))).not.toContain(normal.id);
    expect(ids(await op("GET", "?severity=normal"))).toContain(normal.id);
    expect(ids(await op("GET", "?min_age_minutes=120"))).toContain(high.id);
    expect(ids(await op("GET", "?min_age_minutes=120"))).not.toContain(normal.id);
    expect(ids(await op("GET", "?unassigned=true"))).toContain(high.id);
    expect((await op("GET", "?status=bogus")).statusCode).toBe(400);
    const listed = (await op("GET", "?severity=high")).json().cases.find((x: { id: string }) => x.id === high.id);
    expect(listed.age_minutes).toBeGreaterThanOrEqual(179);
    expect(await op("POST", `/${high.id}/notes`, { note: "Called the bursar; checking the statement" })).toMatchObject({ statusCode: 200 });
    const got = (await op("GET", `/${high.id}`)).json();
    expect(got.evidence).toHaveLength(1);
    expect(got.evidence[0].msisdn_masked).toBe("254*****5678");
    expect(JSON.stringify(got)).not.toMatch(/254712345678/);
    expect(got.notes).toHaveLength(1);
    expect(got.notes[0].author_id).toBe(suId);
    expect((await op("GET", `/${randomUUID()}`)).statusCode).toBe(404);
    expect((await op("POST", `/${high.id}/notes`, { note: "x" })).statusCode).toBe(400);
  });

  it("assignment needs an active platform operator; ownership, escalation and every mutation are audited with prior and resulting state", async () => {
    await superLogin();
    const c = await unmatched();
    expect((await op("POST", `/${c.id}/assign`, { owner_user_id: h.ids.teacherA })).statusCode).toBe(400);
    expect((await op("POST", `/${c.id}/assign`, { owner_user_id: suId })).statusCode).toBe(200);
    expect(await caseOf(c.checkout)).toMatchObject({ owner_user_id: suId });
    expect((await op("GET", `?unassigned=true`)).json().cases.map((x: { id: string }) => x.id)).not.toContain(c.id);
    expect((await op("POST", `/${c.id}/escalate`, { reason: "high value, unattributed" })).statusCode).toBe(200);
    expect((await caseOf(c.checkout)).escalated_at).toBeTruthy();
    const assigned = (await auditOf("finance.unmatched.assigned")).filter((e) => e.detail.includes(c.id));
    expect(assigned[0]!.actor_user_id).toBe(suId);
    expect(assigned[0]!.d).toMatchObject({ caseId: c.id, priorOwner: null, newOwner: suId });
    expect((await auditOf("finance.unmatched.escalated")).some((e) => e.detail.includes(c.id))).toBe(true);
  });

  it("retry matching hands stored evidence to a payment that now owns the checkout id, ONCE, without settling, crediting or failing it", async () => {
    await superLogin();
    const c = await unmatched(0);
    expect((await op("POST", `/${c.id}/retry`)).json()).toEqual({ outcome: "no_match" });
    expect(await caseOf(c.checkout)).toMatchObject({ retry_count: 1, last_retry_outcome: "no_match", status: "open" });
    // the provider-acknowledged id is now recorded on a pending prompt (e.g. a delayed push response was stored)
    const inv = await h.freshInvoice(1_000_000);
    const p = await h.startPrompt(inv, 100_000);
    await h.owner("ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard");
    try {
      await h.owner(`UPDATE finance_payments SET checkout_request_id = $2 WHERE id = $1`, [p.payment.id, c.checkout]);
    } finally {
      await h.owner("ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard");
    }
    const before = await h.invoice(inv);
    expect((await op("POST", `/${c.id}/retry`)).json()).toEqual({ outcome: "matched_payment" });
    const events = await h.owner(`SELECT outcome, result_code, receipt FROM finance_mpesa_events WHERE payment_id = $1 AND checkout_request_id = $2`, [p.payment.id, c.checkout]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "callback_received", result_code: 0 });
    expect(await h.payment(p.payment.id)).toMatchObject({ status: "pending" }); // a callback alone is never proof of payment
    expect(await h.invoice(inv)).toEqual(before); // no money moved
    expect(await caseOf(c.checkout)).toMatchObject({ status: "resolved", resolution: "matched_by_retry", matched_payment_id: p.payment.id });
    expect((await op("POST", `/${c.id}/retry`)).statusCode).toBe(409); // a resolved case is not retried (no duplicate handover)
    expect(await h.owner(`SELECT 1 FROM finance_mpesa_events WHERE payment_id = $1 AND checkout_request_id = $2`, [p.payment.id, c.checkout])).toHaveLength(1);
    expect((await auditOf("finance.unmatched.retried")).some((e) => e.detail.includes(c.id) && e.detail.includes("matched_payment"))).toBe(true);
  });

  it("resolution requires a disposition, reason AND evidence; it cannot claim a checkout id that now belongs to a payment; it is final", async () => {
    await superLogin();
    const c = await unmatched();
    const good = { resolution: "provider_confirmed_not_ours", reason: "Daraja portal shows this id belongs to another shortcode", evidence: "Portal transaction export 2026-11-20, line 14" };
    expect((await op("POST", `/${c.id}/resolve`, { ...good, evidence: "short" })).statusCode).toBe(400);
    expect((await op("POST", `/${c.id}/resolve`, { ...good, reason: "short" })).statusCode).toBe(400);
    expect((await op("POST", `/${c.id}/resolve`, { ...good, resolution: "matched_by_retry" })).statusCode).toBe(400); // that disposition is automatic only
    expect(await caseOf(c.checkout)).toMatchObject({ status: "open" });
    expect((await op("POST", `/${c.id}/resolve`, good)).statusCode).toBe(200);
    expect(await caseOf(c.checkout)).toMatchObject({ status: "resolved", resolution: "provider_confirmed_not_ours", resolved_by: suId });
    expect((await op("POST", `/${c.id}/resolve`, good)).statusCode).toBe(409);
    expect((await op("POST", `/${c.id}/assign`, { owner_user_id: suId })).statusCode).toBe(409);
    const ev = (await auditOf("finance.unmatched.resolved")).find((e) => e.detail.includes(c.id))!;
    expect(ev.d).toMatchObject({ priorStatus: "open", newStatus: "resolved", resolution: "provider_confirmed_not_ours" });
    // a case whose checkout id now belongs to a payment must go through retry, never "not ours"
    const inv = await h.freshInvoice(500_000);
    const p = await h.startPrompt(inv, 50_000);
    expect((await cb(p.checkout + "_NOPE", 0)).statusCode).toBe(200); // unrelated quarantine row
    const mism = await unmatched();
    await h.owner("ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard");
    try {
      await h.owner(`UPDATE finance_payments SET checkout_request_id = $2 WHERE id = $1`, [p.payment.id, mism.checkout]);
    } finally {
      await h.owner("ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard");
    }
    expect((await op("POST", `/${mism.id}/resolve`, good)).statusCode).toBe(409);
  });

  it("late CONTRADICTORY evidence is preserved and reopens a resolved case; an identical repeat does not; operators can reopen with a reason", async () => {
    await superLogin();
    const checkout = checkoutId();
    const r1 = receipt();
    expect((await cb(checkout, 0, { amount: 100, receipt: r1 })).statusCode).toBe(200);
    const c = await caseOf(checkout);
    expect((await op("POST", `/${c.id}/resolve`, { resolution: "provider_confirmed_failed", reason: "Provider portal reported the request as failed", evidence: "Portal screenshot ref #889" })).statusCode).toBe(200);
    // identical duplicate: stays resolved, only counted
    expect((await cb(checkout, 0, { amount: 100, receipt: r1 })).statusCode).toBe(200);
    expect(await caseOf(checkout)).toMatchObject({ status: "resolved", occurrences: 2, reopened_count: 0 });
    // contradictory: same checkout, different receipt and amount
    const r2 = receipt();
    expect((await cb(checkout, 0, { amount: 250, receipt: r2 })).statusCode).toBe(200);
    expect(await caseOf(checkout)).toMatchObject({ status: "open", contradictory: true, reopened_count: 1, resolution: null, resolved_by: null });
    const ev = await evidenceOf(c.id);
    expect(ev.map((e) => e.receipt).sort()).toEqual([r1, r2].sort()); // nothing was overwritten
    const reopened = (await auditOf("finance.unmatched.reopened")).find((e) => e.detail.includes(c.id))!;
    expect(reopened.d).toMatchObject({ priorStatus: "resolved", priorResolution: "provider_confirmed_failed", newStatus: "open", cause: "new_distinct_provider_evidence" });
    // operator reopen
    expect((await op("POST", `/${c.id}/reopen`, { reason: "long enough reason" })).statusCode).toBe(409); // already open
    expect((await op("POST", `/${c.id}/resolve`, { resolution: "other_evidenced", reason: "Both receipts checked against the statement", evidence: "Statement lines 3 and 4" })).statusCode).toBe(200);
    expect((await op("POST", `/${c.id}/reopen`, { reason: "short" })).statusCode).toBe(400);
    expect((await op("POST", `/${c.id}/reopen`, { reason: "Finance asked for another look" })).statusCode).toBe(200);
    expect(await caseOf(checkout)).toMatchObject({ status: "open", reopened_count: 2 });
  });

  it("the database itself refuses a resolution without reason and evidence (not only the route validation)", async () => {
    await superLogin();
    const c = await unmatched();
    for (const [reason, evidence] of [["long enough reason", "short"], ["short", "long enough evidence"], ["long enough reason", null], [null, "long enough evidence"]] as const) {
      await expect(
        h.asApp(null, (cl) =>
          cl.query(`SELECT set_config('app.user_id', $1, true)`, [suId]).then(() => cl.query(`SELECT public.finance_unmatched_resolve($1, 'other_evidenced', $2, $3)`, [c.id, reason, evidence])),
        ),
      ).rejects.toMatchObject({ code: "22023" });
    }
    expect(await caseOf(c.checkout)).toMatchObject({ status: "open" });
  });

  it("concurrent resolution has exactly one winner", async () => {
    await superLogin();
    const c = await unmatched();
    const body = { resolution: "other_evidenced", reason: "Checked with the provider portal", evidence: "Portal export reference 4471" };
    const rs = await Promise.all([op("POST", `/${c.id}/resolve`, body), op("POST", `/${c.id}/resolve`, body), op("POST", `/${c.id}/resolve`, body)]);
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(2);
    expect((await auditOf("finance.unmatched.resolved")).filter((e) => e.detail.includes(c.id))).toHaveLength(1);
  });

  it("the worker sweep re-evaluates open cases, escalates stale ones (4 h for a provider success, 24 h otherwise) and only the worker may run it", async () => {
    await superLogin();
    const stale = await unmatched(0);
    const slow = await unmatched(1032);
    const fresh = await unmatched(0);
    await h.owner(`UPDATE finance_unmatched_cases SET first_seen_at = now() - interval '5 hours' WHERE id = ANY($1)`, [[stale.id, slow.id]]);
    await expect(h.asApp(null, (c) => c.query(`SELECT * FROM public.finance_unmatched_sweep('x')`))).rejects.toMatchObject({ code: "42501" });
    const out = await workerTx((c) => c.query(`SELECT * FROM public.finance_unmatched_sweep('um-worker')`));
    expect(out.rows[0].evaluated).toBeGreaterThanOrEqual(3);
    expect((await caseOf(stale.checkout)).escalated_at).toBeTruthy(); // success evidence: 4 h
    expect((await caseOf(slow.checkout)).escalated_at).toBeNull(); // plain failure: 24 h
    expect((await caseOf(fresh.checkout)).escalated_at).toBeNull();
    expect((await caseOf(stale.checkout)).last_evaluated_at).toBeTruthy();
    const esc = (await auditOf("finance.unmatched.escalated")).filter((e) => e.detail.includes(stale.id));
    expect(esc).toHaveLength(1);
    expect(esc[0]!.actor_user_id).toBeNull();
    await workerTx((c) => c.query(`SELECT * FROM public.finance_unmatched_sweep('um-worker')`));
    expect((await auditOf("finance.unmatched.escalated")).filter((e) => e.detail.includes(stale.id))).toHaveLength(1); // escalated once
    // the worker never decides an outcome: it cannot resolve or touch the ledger tables
    await expect(h.asApp(null, (c) => c.query(`UPDATE finance_unmatched_cases SET status = 'resolved'`), h.workerPool)).rejects.toMatchObject({ code: "42501" });
  });

  it("platform status counts open, escalated and unassigned cases and the oldest age", async () => {
    await superLogin();
    await unmatched();
    const s = (await h.call("GET", "/v1/platform/ops/status", su)).json().status;
    expect(s.unmatched_cases.open).toBeGreaterThanOrEqual(1);
    expect(s.unmatched_cases).toEqual(expect.objectContaining({ escalated_open: expect.any(Number), unassigned_open: expect.any(Number) }));
    expect(JSON.stringify(s)).not.toMatch(/ws_CO_|254\d{9}/); // counts and ages only
  });
});
