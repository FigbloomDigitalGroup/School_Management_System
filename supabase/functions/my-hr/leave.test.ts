// my-hr's leave and approval routes (SCHOOLS_HR_LEAVE_CONTRACT.md section 3), against the fake HR.
import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { FakeSupabaseClient, type Row } from "../_shared/fakeSupabase.ts";
import { FakePlatform } from "../_shared/fakePlatform.ts";
import { ANNUAL, FakeHr, HR_BASE, SICK } from "../_shared/fakeHr.ts";
import { CONNECT_ONCE, handle, MAX_DOCUMENT_BYTES } from "./index.ts";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const OTHER_SCHOOL = "22222222-2222-4222-8222-222222222222";

const PEOPLE: Row[] = [
  { id: "teacher", role: "teacher", tenant_id: SCHOOL, archived_at: null },
  { id: "principal", role: "school_admin", tenant_id: SCHOOL, archived_at: null },
  { id: "deputy", role: "teacher", tenant_id: SCHOOL, archived_at: null },
  { id: "bursar", role: "staff", tenant_id: SCHOOL, archived_at: null },
  { id: "cook", role: "staff", tenant_id: SCHOOL, archived_at: null },
  { id: "parent", role: "parent", tenant_id: SCHOOL, archived_at: null },
  { id: "other-teacher", role: "teacher", tenant_id: OTHER_SCHOOL, archived_at: null },
];
/** Who holds which admin areas (staff_permissions / school roles). */
const AREAS: Record<string, string[]> = { deputy: ["leave", "academics"], bursar: ["fees"], cook: ["inventory"] };

interface Setup {
  caller: string;
  /** hr_leave_access().status */
  status?: "not_staff" | "off" | "not_linked" | "not_enabled" | "available";
  /** my_hr_status() (the read-only routes): leave doesn't depend on it */
  myHr?: string;
}

/** hr_leave_access() (20261105800000), for the fake: the caller's own staff profile, then the switch and the school. */
function access(admin: FakeSupabaseClient, caller: string, status: string): Row {
  const me = admin.rowsIn("profiles").find((p) => p.id === caller);
  if (!me || !["teacher", "driver", "staff", "school_admin"].includes(String(me.role)) || me.archived_at) return { status: "not_staff", approver: false };
  return { status, approver: me.role === "school_admin" || (AREAS[caller] ?? []).some((a) => a === "leave" || a === "fees") };
}

function setup({ caller, status = "available", myHr = "off" }: Setup) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", PEOPLE);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: caller, email: `${caller}@reu.ac.ke` };
  const asked: string[] = [];
  asUser.rpc = (name: string) => {
    asked.push(name);
    if (name === "hr_leave_access") return Promise.resolve({ data: access(admin, caller, status), error: null });
    if (name === "my_hr_status") return Promise.resolve({ data: myHr, error: null });
    return Promise.resolve({ data: null, error: { message: `rpc ${name}` } });
  };
  const hr = new FakeHr();
  hr.link(SCHOOL, "company-reu");
  hr.link(OTHER_SCHOOL, "company-other");
  hr.hire("company-reu", "teacher", { number: "EMP-001", name: "Tom Teacher" });
  hr.hire("company-reu", "principal", { number: "EMP-002", name: "Mary Principal" });
  hr.hire("company-reu", "deputy", { number: "EMP-003", name: "Dora Deputy" });
  hr.hire("company-reu", "bursar", { number: "EMP-004", name: "Ben Bursar" });
  hr.hire("company-other", "other-teacher", { number: "EMP-900", name: "Olga Other" });
  hr.approverLink("company-reu", "principal", "hr-user-principal");
  hr.approverLink("company-reu", "bursar", "hr-user-bursar");
  hr.firstApprover.set("company-reu", "hr-user-principal");
  hr.clock = () => Date.parse("2026-11-05T08:00:00Z");
  const platform = new FakePlatform();
  return { admin, asUser, hr, platform, asked, deps: { admin, asUser, client: platform.client(), hrUrl: HR_BASE, fetch: hr.fetch } };
}

function request(body: unknown) {
  return new Request("https://example.com/my-hr", { method: "POST", headers: { Authorization: "Bearer user-jwt" }, body: JSON.stringify(body) });
}

async function call(ctx: ReturnType<typeof setup>, body: Record<string, unknown>) {
  const res = await handle(request(body), ctx.deps);
  return { res, out: await res.json() };
}

const APPLY = { route: "leave_apply", type_id: ANNUAL, start_date: "2026-11-16", end_date: "2026-11-17", reason: "Family wedding upcountry" };
/** base64 of `bytes` bytes (all zero). */
const b64 = (bytes: number) => "A".repeat(Math.ceil(bytes / 3) * 4).slice(0, Math.floor(bytes / 3) * 4) + (bytes % 3 === 1 ? "AA==" : bytes % 3 === 2 ? "AAA=" : "");

describe("my-hr leave: applying through HR", () => {
  it("the form comes from HR's leave/form for the caller's own school and person", async () => {
    const ctx = setup({ caller: "teacher" });
    const { res, out } = await call(ctx, { route: "leave_form", school: OTHER_SCHOOL, person: "other-teacher" });
    assertEquals(res.status, 200);
    assertEquals(out.leave_types.length, 2);
    assertEquals(ctx.hr.calls.map((c) => [c.method, c.path, c.school, c.person]), [["GET", "leave/form", SCHOOL, "teacher"]]);
    assertEquals(ctx.asked, ["hr_leave_access"], "the leave routes ask hr_leave_access, not my_hr_status");
  });

  it("applies with only the fields HR takes: ids come from the session, never the body", async () => {
    const ctx = setup({ caller: "teacher" });
    const { res, out } = await call(ctx, {
      ...APPLY, tenant_id: OTHER_SCHOOL, teacher_id: "other-teacher", external_id: "other-teacher", employee_number: "EMP-900", status: "approved",
    });
    assertEquals(res.status, 201);
    assertEquals(out.application.status, "pending");
    const sent = ctx.hr.calls[0]!;
    assertEquals([sent.method, sent.path, sent.school, sent.person], ["POST", "leave/applications", SCHOOL, "teacher"]);
    assertEquals(sent.body, { type_id: ANNUAL, start_date: "2026-11-16", end_date: "2026-11-17", half_day: false, reason: "Family wedding upcountry" });
    assertEquals(ctx.hr.applications[0]!.person, "teacher");
    assertEquals(ctx.hr.applications[0]!.days, 2);
  });

  it("the list (balances and approval progress) is HR's GET leave", async () => {
    const ctx = setup({ caller: "teacher" });
    await call(ctx, APPLY);
    const { res, out } = await call(ctx, { route: "leave_applications" });
    assertEquals(res.status, 200);
    assertEquals(out.applications.length, 1);
    assertEquals(out.applications[0].approval.steps[0].status, "current");
    assertEquals(ctx.hr.calls[1]!.path, "leave");
  });

  it("a document up to 3 MB goes to HR as base64 (HR's production takes about 4.5 MB per request)", async () => {
    const ctx = setup({ caller: "teacher" });
    const base64 = b64(MAX_DOCUMENT_BYTES);
    const { res } = await call(ctx, { ...APPLY, type_id: SICK, document: { name: "note.pdf", content_type: "application/pdf", base64 } });
    assertEquals(res.status, 201);
    // deno-lint-ignore no-explicit-any
    assertEquals((ctx.hr.calls[0]!.body as any).document, { name: "note.pdf", content_type: "application/pdf", base64 });
    assertEquals(ctx.hr.applications[0]!.document?.bytes, MAX_DOCUMENT_BYTES);
  });

  it("refuses a document over 5 MB, of another type, or not base64, without calling HR", async () => {
    const ctx = setup({ caller: "teacher" });
    const doc = (d: Row) => call(ctx, { ...APPLY, document: { name: "note.pdf", content_type: "application/pdf", base64: b64(10), ...d } });
    let r = await doc({ base64: b64(MAX_DOCUMENT_BYTES + 1) });
    assertEquals([r.res.status, r.out.code], [413, "document_too_large"]);
    r = await doc({ content_type: "application/x-msdownload" });
    assertEquals([r.res.status, r.out.code], [400, "invalid_document"]);
    r = await doc({ base64: "not base64!" });
    assertEquals([r.res.status, r.out.code], [400, "invalid_document"]);
    r = await doc({ name: "../../etc/passwd" });
    assertEquals([r.res.status, r.out.code], [400, "invalid_document"]);
    const huge = await handle(new Request("https://example.com/my-hr", {
      method: "POST", headers: { Authorization: "Bearer user-jwt" }, body: JSON.stringify({ ...APPLY, document: { base64: "A".repeat(8_000_000) } }),
    }), ctx.deps);
    assertEquals(huge.status, 413);
    assertEquals(ctx.hr.calls.length, 0);
  });

  it("refuses a malformed application without calling HR", async () => {
    const ctx = setup({ caller: "teacher" });
    for (const [bad, code] of [
      [{ type_id: "" }, "invalid_type"],
      [{ type_id: "../x" }, "invalid_type"],
      [{ start_date: "16/11/2026" }, "invalid_dates"],
      [{ start_date: "2026-11-18" }, "invalid_dates"],
      [{ end_date: "2028-01-01" }, "invalid_dates"],
      [{ half_day: "morning" }, "invalid_half_day"],
      [{ half_day: true }, "invalid_half_day"],
      [{ reason: "  " }, "invalid_reason"],
      [{ reason: "Too short" }, "invalid_reason"],
      [{ reason: "x".repeat(2001) }, "invalid_reason"],
    ] as const) {
      const { res, out } = await call(ctx, { ...APPLY, ...bad });
      assertEquals([res.status, out.code], [400, code], JSON.stringify(bad));
    }
    assertEquals(ctx.hr.calls.length, 0);
  });

  it("HR's own rules (a document needed, the balance, an overlap) come back as HR's sentence", async () => {
    const ctx = setup({ caller: "teacher" });
    let r = await call(ctx, { ...APPLY, type_id: SICK });
    assertEquals([r.res.status, r.out.code, r.out.error, r.out.problems], [422, "leave_rules", "Sick leave needs a Doctor's note.", ["Sick leave needs a Doctor's note"]]);
    await call(ctx, APPLY);
    r = await call(ctx, APPLY);
    assertEquals([r.res.status, r.out.code, r.out.problems], [422, "leave_rules", ["You already have leave on some of these days"]]);
    ctx.hr.rawAnswer = { status: 413, body: JSON.stringify({ error: { code: "too_large", message: "The request is too large (a document can be 5 MB at most)." } }), type: "application/json" };
    r = await call(ctx, APPLY);
    assertEquals([r.res.status, r.out.code], [413, "document_too_large"]);
  });

  it("cancels the caller's own application only", async () => {
    const ctx = setup({ caller: "teacher" });
    await call(ctx, APPLY);
    const id = ctx.hr.applications[0]!.id;
    const other = setup({ caller: "deputy" });
    other.hr.applications = ctx.hr.applications;
    let r = await call(other, { route: "leave_cancel", application_id: id });
    assertEquals([r.res.status, r.out.code], [404, "not_found"]);
    r = await call(ctx, { route: "leave_cancel", application_id: id, person: "deputy" });
    assertEquals(r.res.status, 200);
    assertEquals(ctx.hr.applications[0]!.status, "cancelled");
    assertEquals(ctx.hr.calls.at(-1)!.path, `leave/applications/${id}/cancel`);
    r = await call(ctx, { route: "leave_cancel", application_id: id });
    assertEquals([r.res.status, r.out.code], [409, "not_cancellable"]);
    r = await call(ctx, { route: "leave_cancel", application_id: "../approvals" });
    assertEquals([r.res.status, r.out.code], [400, "invalid_application"]);
  });
});

describe("my-hr leave: the switch", () => {
  for (const [status, code, http] of [
    ["off", "hr_leave_off", 403], ["not_enabled", "hr_leave_off", 403], ["not_linked", "school_not_linked", 409],
  ] as const) {
    it(`hr_leave_access ${status}: refused (${code}), HR not called`, async () => {
      const ctx = setup({ caller: "teacher", status });
      for (const route of ["leave_form", "leave_applications", "approvals"]) {
        const { res, out } = await call(ctx, { route, ...(route === "leave_apply" ? APPLY : {}) });
        assertEquals([res.status, out.code], [http, code]);
      }
      assertEquals(ctx.hr.calls.length, 0);
      assertEquals(ctx.platform.tokensIssued, 0);
    });
  }

  it("not staff (a parent): refused", async () => {
    const ctx = setup({ caller: "parent" });
    const { res, out } = await call(ctx, { route: "leave_form" });
    assertEquals([res.status, out.code], [403, "forbidden"]);
    assertEquals(ctx.hr.calls.length, 0);
  });

  it("works while My HR (MY_HR_ENABLED) is off: the two switches are separate", async () => {
    const ctx = setup({ caller: "teacher", myHr: "off" });
    assertEquals((await call(ctx, { route: "leave_form" })).res.status, 200);
    assertEquals((await call(ctx, { route: "summary" })).res.status, 403);
  });
});

describe("my-hr leave: approving inside Schools", () => {
  it("the principal sees what waits on their HR user, with the document link, and approves it as that HR user", async () => {
    const ctx = setup({ caller: "teacher" });
    await call(ctx, { ...APPLY, type_id: SICK, document: { name: "note.pdf", content_type: "application/pdf", base64: b64(300) } });
    const principal = setup({ caller: "principal" });
    principal.hr.applications = ctx.hr.applications;
    principal.hr.events = ctx.hr.events;
    let r = await call(principal, { route: "approvals" });
    assertEquals(r.res.status, 200);
    assertEquals(r.out.approvals.length, 1);
    assertEquals(r.out.approvals[0].employee.name, "Tom Teacher");
    assertEquals(r.out.approvals[0].document.name, "note.pdf");
    assert(r.out.approvals[0].document.url.startsWith("https://"));
    assert(r.out.approvals[0].document.expires_at);
    assertEquals(principal.hr.calls[0]!.person, "principal");

    const id = ctx.hr.applications[0]!.id;
    r = await call(principal, { route: "approval_decide", application_id: id, decision: "approve", comment: " Get well soon ", employee: "x" });
    assertEquals(r.res.status, 200);
    assertEquals(principal.hr.calls[1]!.body, { decision: "approve", comment: "Get well soon" });
    assertEquals(ctx.hr.applications[0]!.decisions[0]!.by, "hr-user-principal");
    assertEquals(ctx.hr.events.map((e) => [e.type, e.data.application_id, e.data.external_id]), [["hr.leave.approved", id, "teacher"]]);
  });

  it("not linked to an HR user (never opened HR & Payroll): 409 approver_not_linked, \"connect once\"", async () => {
    const ctx = setup({ caller: "deputy" });
    const { res, out } = await call(ctx, { route: "approvals" });
    assertEquals([res.status, out.code, out.error], [409, "approver_not_linked", CONNECT_ONCE]);
  });

  it("a linked HR login that is no longer an active member: 403 approver_no_access", async () => {
    const ctx = setup({ caller: "principal" });
    ctx.hr.noAccess.add("hr-user-principal");
    const { res, out } = await call(ctx, { route: "approvals" });
    assertEquals([res.status, out.code], [403, "approver_no_access"]);
  });

  it("a teacher or staff member without the leave or fees area isn't an approver: refused before HR", async () => {
    for (const caller of ["teacher", "cook"]) {
      const ctx = setup({ caller });
      const { res, out } = await call(ctx, { route: "approvals" });
      assertEquals([res.status, out.code], [403, "not_approver"]);
      assertEquals(ctx.hr.calls.length, 0);
    }
  });

  it("the bursar (fees area) and deputy (leave area) may ask; HR decides who has items", async () => {
    const bursar = setup({ caller: "bursar" });
    const { res, out } = await call(bursar, { route: "approvals" });
    assertEquals(res.status, 200);
    assertEquals(out.approvals, []);
  });

  it("deciding one that doesn't wait on you is HR's refusal (403); declining needs HR's comment; a bad decision never reaches HR", async () => {
    const ctx = setup({ caller: "teacher" });
    await call(ctx, APPLY);
    const id = ctx.hr.applications[0]!.id;
    const bursar = setup({ caller: "bursar" });
    bursar.hr.applications = ctx.hr.applications;
    let r = await call(bursar, { route: "approval_decide", application_id: id, decision: "approve" });
    assertEquals([r.res.status, r.out.code, r.out.error], [403, "not_your_approval", "You are not the approver for this step."]);
    const principal = setup({ caller: "principal" });
    principal.hr.applications = ctx.hr.applications;
    r = await call(principal, { route: "approval_decide", application_id: id, decision: "decline" });
    assertEquals([r.res.status, r.out.code, r.out.error], [422, "invalid", "Please give a reason for declining."]);
    r = await call(principal, { route: "approval_decide", application_id: id, decision: "maybe" });
    assertEquals([r.res.status, r.out.code], [400, "invalid_decision"]);
    r = await call(principal, { route: "approval_decide", application_id: id, decision: "decline", comment: 42 });
    assertEquals([r.res.status, r.out.code], [400, "invalid_comment"]);
    r = await call(principal, { route: "approval_decide", application_id: id, decision: "decline", comment: "Exams week" });
    assertEquals(r.res.status, 200);
    assertEquals(ctx.hr.applications[0]!.status, "declined");
    assertFalse(principal.hr.calls.some((c) => (c.body as Row | undefined)?.decision === "maybe"));
    r = await call(principal, { route: "approval_decide", application_id: id, decision: "approve" });
    assertEquals([r.res.status, r.out.code], [409, "already_decided"]);
  });
});
