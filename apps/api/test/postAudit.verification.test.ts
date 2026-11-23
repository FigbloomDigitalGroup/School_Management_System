import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { financeHarness, PASSWORD } from "./support/financeHarness.js";

/**
 * Executed verification of audit items that were previously only source-read (FBIV): visitor PII (S12-03), device
 * token reclaim (S12-10), SECURITY INVOKER count (S13-11), leave authorization (S13-05/06), reporting (S14-1/3/4),
 * and the learner CSV import end to end (S16-1/3/4/5/11, OA-2) with concurrency and rollback.
 */
describe("post-audit: executed verification of previously source-read items", () => {
  const h = financeHarness();
  const url = (p: string) => `/v1/tenants/${h.A()}${p}`;
  const as = (token: string, method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: unknown) => h.call(method, url(path), token, payload, { "x-tenant-id": h.A() });
  const teacher = () => h.login({ tenantId: h.A(), loginId: "TC-0001", password: PASSWORD });
  const parent = () => h.login({ tenantId: h.A(), loginId: "PT-0001", password: PASSWORD });

  it("S12-03: a host teacher sees a visit but never the visitor's phone, ID number, plate or recorder; the desk keeps full detail", async () => {
    const v = await as(h.admin, "POST", "/gate-visits", { visitor_name: "PII Visitor", visitor_phone: "254700111222", id_number: "12345678", vehicle_plate: "KDA123A", purpose: "meeting", host_kind: "teacher", host_user_id: h.ids.teacherA });
    expect(v.statusCode, JSON.stringify(v.json())).toBe(201);
    const id = v.json().visit.id as string;
    const t = await teacher();
    const list = await as(t, "GET", "/gate-visits?mine=1");
    const mine = list.json().visits.find((x: { id: string }) => x.id === id);
    expect(mine).toBeTruthy();
    expect(mine).toMatchObject({ visitor_phone: null, id_number: null, vehicle_plate: null });
    const one = (await as(t, "GET", `/gate-visits/${id}`)).json().visit;
    expect(one).toMatchObject({ visitor_phone: null, id_number: null, vehicle_plate: null });
    const desk = (await as(h.admin, "GET", `/gate-visits/${id}`)).json().visit;
    expect(desk).toMatchObject({ visitor_phone: "254700111222", id_number: "12345678", vehicle_plate: "KDA123A" });
    // a parent cannot read someone else's visit at all
    expect([403, 404]).toContain((await as(await parent(), "GET", `/gate-visits/${id}`)).statusCode);
  });

  it("S12-10: registering a device token that belongs to another user moves it and records an audit event naming the previous holder", async () => {
    const tok = "fcm-" + randomUUID();
    const a = await h.call("POST", "/v1/me/device-tokens", await teacher(), { token: tok, platform: "android" });
    expect(a.statusCode).toBeLessThan(300);
    const b = await h.call("POST", "/v1/me/device-tokens", h.admin, { token: tok, platform: "android" });
    expect(b.statusCode).toBeLessThan(300);
    expect((await h.owner(`SELECT user_id FROM device_tokens WHERE token = $1`, [tok]))[0]!.user_id).toBe(h.ids.adminA);
    const ev = await h.owner(`SELECT actor_user_id, detail FROM security_audit_events WHERE event_type = 'communications.device_token.reclaimed' ORDER BY occurred_at DESC LIMIT 1`);
    expect(ev[0]).toMatchObject({ actor_user_id: h.ids.adminA });
    expect(ev[0]!.detail).toMatchObject({ previousUserId: h.ids.teacherA });
    expect(JSON.stringify(ev[0]!.detail)).not.toContain(tok); // the token itself is never written to the audit trail
  });

  it("S13-11: inventory_out_count is SECURITY INVOKER; school B's session cannot count school A's issues", async () => {
    expect((await h.owner(`SELECT prosecdef FROM pg_proc WHERE proname = 'inventory_out_count'`))[0]!.prosecdef).toBe(false);
    const item = (await h.owner<{ id: string }>(`INSERT INTO inventory_items (tenant_id, name, category, tracking, quantity) VALUES ($1, 'Desks', 'furniture', 'stock', 5) RETURNING id`, [h.A()]))[0]!.id;
    await h.owner(`INSERT INTO inventory_issues (tenant_id, item_id, holder_user_id, quantity, status) VALUES ($1, $2, $3, 2, 'out')`, [h.A(), item, h.ids.teacherA]);
    const own = await h.asApp(h.A(), (c) => c.query<{ n: number }>(`SELECT public.inventory_out_count($1) AS n`, [item]));
    expect(own.rows[0]!.n).toBe(2);
    const cross = await h.asApp(h.ids.tenantB, (c) => c.query<{ n: number }>(`SELECT public.inventory_out_count($1) AS n`, [item]));
    expect(cross.rows[0]!.n).toBe(0);
  });

  it("S13-05/S13-06: only staff submit leave; a request is cancelled only by its owner or a reviewer; no overlap; bad dates are 4xx", async () => {
    const pc = await as(await parent(), "POST", "/leave-requests", { start_on: "2031-03-01", end_on: "2031-03-02", reason: "parent leave" });
    expect(pc.statusCode).toBe(403);
    const t = await teacher();
    const ok = await as(t, "POST", "/leave-requests", { start_on: "2031-03-01", end_on: "2031-03-03", reason: "family event" });
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(201);
    const leaveId = ok.json().leave_request.id as string;
    expect((await as(t, "POST", "/leave-requests", { start_on: "2031-03-02", end_on: "2031-03-04", reason: "overlap" })).statusCode).toBe(409);
    expect((await as(t, "POST", "/leave-requests", { start_on: "2031-02-31", end_on: "2031-03-04", reason: "impossible date" })).statusCode).toBeLessThan(500);
    expect((await as(await parent(), "POST", `/leave-requests/${leaveId}/cancel`)).statusCode).toBe(403); // not the owner, not a reviewer
    expect((await as(t, "POST", `/leave-requests/${leaveId}/cancel`)).statusCode).toBe(200);
    expect((await as(t, "POST", `/leave-requests/${leaveId}/cancel`)).statusCode).toBe(409); // no longer pending
    expect((await as(t, "POST", `/leave-requests/${randomUUID()}/cancel`)).statusCode).toBe(404);
  });

  it("S14-1/S14-3/S14-4: finance summary needs the finance permission; a foreign term is 404; an impossible date is 400, not 500", async () => {
    const t = await teacher();
    expect((await as(t, "GET", "/reports/finance-summary")).statusCode).toBe(403);
    expect((await as(h.admin, "GET", "/reports/finance-summary")).statusCode).toBe(200);
    expect((await as(h.admin, "GET", `/reports/finance-summary?termId=${randomUUID()}`)).statusCode).toBe(404);
    expect((await as(h.admin, "GET", "/reports/attendance-daily?date=2026-02-31")).statusCode).toBe(400);
    expect((await as(h.admin, "GET", "/reports/attendance-daily?date=not-a-date")).statusCode).toBe(400);
    expect((await as(h.admin, "GET", "/reports/attendance-daily?date=2026-03-02")).statusCode).toBe(200);
  });

  // ---------------------------------------------------------------- import end to end
  const imp = (p: string, payload: unknown) => as(h.admin, "POST", `/imports/learners/${p}`, payload);
  const HDR = "admission_no,full_name,gender,date_of_birth,boarding\n";
  const count = async (like: string) => (await h.owner<{ n: number }>(`SELECT count(*)::int AS n FROM learners WHERE tenant_id = $1 AND admission_no LIKE $2`, [h.A(), like]))[0]!.n;

  it("import e2e: malformed, oversized, archived-duplicate, quoted-newline and escaped-quote inputs behave; nothing is created by a preview", async () => {
    await h.owner(`INSERT INTO learners (tenant_id, admission_no, full_name, gender, archived_at, active) VALUES ($1, 'IMPARCH1', 'Old Learner', 'male', now(), false)`, [h.A()]);
    const csv = HDR + "IMPARCH1,Dup Archived,male,2014-01-01,false\nIMPOK1,\"Quoted, Name\nWith Newline\",female,2014-01-02,false\nIMPOK2,\"Esc \"\"Quote\"\" Name\",male,2014-01-03,true\nIMPBAD,Bad Date,male,2026-02-31,false\n";
    const r = await imp("preview", { csv });
    expect(r.statusCode).toBe(200);
    const p = r.json().preview;
    expect(p).toMatchObject({ row_count: 4, valid_count: 2, error_count: 2 });
    expect(JSON.stringify(p.errors)).toMatch(/archived/);
    expect(JSON.stringify(p.errors)).toMatch(/valid date/);
    expect(await count("IMP%")).toBe(1); // only the archived fixture; the preview created nothing
    expect((await imp("apply", { import_id: p.import_id })).statusCode).toBe(400); // a preview with errors cannot be applied
    expect((await imp("preview", { csv: "admission_no,admission_no\nA,B\n" })).statusCode).toBe(400);
    expect((await imp("preview", { csv: HDR + "X1,Name,male,2014-01-01,false,extra\n" })).statusCode).toBeLessThan(500);
    const big = HDR + Array.from({ length: 1001 }, (_, i) => `BIG${i},Big Name ${i},male,2014-01-01,false`).join("\n");
    expect((await imp("preview", { csv: big })).statusCode).toBe(400);
    const huge = await imp("preview", { csv: "x".repeat(1_700_000) });
    expect([400, 413]).toContain(huge.statusCode); // over the route body limit
  });

  it("import e2e: another user cannot apply my preview; concurrent applies create each learner exactly once; a conflict at apply rolls everything back", async () => {
    const csv = HDR + "IMPC1,Concurrent One,male,2014-01-01,false\nIMPC2,Concurrent Two,female,2014-01-02,false\n";
    const id = (await imp("preview", { csv })).json().preview.import_id as string;
    // ownership: re-attribute the batch to someone else -> 403
    await h.owner(`UPDATE import_batches SET created_by = $2 WHERE id = $1`, [id, h.ids.teacherA]);
    expect((await imp("apply", { import_id: id })).statusCode).toBe(403);
    await h.owner(`UPDATE import_batches SET created_by = $2 WHERE id = $1`, [id, h.ids.adminA]);
    const both = await Promise.all([imp("apply", { import_id: id }), imp("apply", { import_id: id })]);
    expect(both.map((x) => x.statusCode)).toEqual([200, 200]);
    const flags = both.map((x) => x.json().result.replayed === true).sort();
    expect(flags).toEqual([false, true]); // exactly one did the work, the other replayed it
    expect(await count("IMPC%")).toBe(2);
    expect((await h.owner(`SELECT status, created_count FROM import_batches WHERE id = $1`, [id]))[0]).toMatchObject({ status: "applied", created_count: 2 });
    // rollback: a row that conflicts only at apply time must leave NO partial learners behind
    const id2 = (await imp("preview", { csv: HDR + "IMPR1,Roll One,male,2014-01-01,false\nIMPR2,Roll Two,male,2014-01-01,false\n" })).json().preview.import_id as string;
    await h.owner(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'IMPR2', 'Raced In', 'male')`, [h.A()]);
    const clash = await imp("apply", { import_id: id2 });
    expect(clash.statusCode).toBe(409);
    expect(await count("IMPR%")).toBe(1); // only the racer; IMPR1 was rolled back
    expect((await h.owner(`SELECT status FROM import_batches WHERE id = $1`, [id2]))[0]!.status).toBe("previewed");
  });
});
