// hr.leave.approved / hr.leave.cancelled on platform-events (SCHOOLS_HR_LEAVE_CONTRACT.md section 3).
import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient, type Row } from "../_shared/fakeSupabase.ts";
import { signFigbloomWebhook } from "../_shared/platformWebhook.ts";
import { ANNUAL, FakeHr, HR_BASE } from "../_shared/fakeHr.ts";
import { FakePlatform } from "../_shared/fakePlatform.ts";
import { handle as myHr } from "../my-hr/index.ts";
import { handle } from "./index.ts";

const SECRET = "w".repeat(64);
const NOW = Date.parse("2026-11-05T10:00:00Z");
const SCHOOL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SCHOOL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL = "33333333-3333-4333-8333-333333333333";
const SUB = "44444444-4444-4444-8444-444444444444";
const CLASS = "55555555-5555-4555-8555-555555555555";
const MATHS = "66666666-6666-4666-8666-666666666666";

function makeDb({ events = true, hrLeave = true } = {}) {
  const db = new FakeSupabaseClient();
  db.platformEventsEnabled = events;
  db.hrLeaveEnabled = hrLeave;
  db.clock = () => NOW;
  db.seed("tenants", [{ id: SCHOOL, name: "Hillside Primary" }, { id: OTHER_SCHOOL, name: "Bungoma High" }]);
  db.seed("profiles", [
    { id: PRINCIPAL, tenant_id: SCHOOL, role: "school_admin", full_name: "Mary Principal", archived_at: null, created_at: "2026-01-01T00:00:00Z" },
    { id: TEACHER, tenant_id: SCHOOL, role: "teacher", full_name: "Sketch Kamau", archived_at: null },
    { id: SUB, tenant_id: SCHOOL, role: "teacher", full_name: "Sam Sub", archived_at: null },
    { id: PARENT, tenant_id: SCHOOL, role: "parent", full_name: "Peter Otieno", archived_at: null },
  ]);
  db.seed("classes", [{ id: CLASS, tenant_id: SCHOOL, name: "Grade 6 East" }]);
  db.seed("subjects", [{ id: MATHS, tenant_id: SCHOOL, name: "Mathematics" }]);
  return db;
}

let seq = 0;
function leaveEvent(type: "hr.leave.approved" | "hr.leave.cancelled", data: Row = {}, event: Row = {}) {
  return JSON.stringify({
    event: {
      type, id: `evt-${++seq}`, occurred_at: "2026-11-05T09:00:00Z", source: "hr",
      platform_tenant_id: "99999999-9999-4999-8999-999999999999", tenant_local_id: SCHOOL,
      data: {
        application_id: "app-1", external_id: TEACHER, employee_number: "EMP-0007", leave_type: "Annual leave",
        start_date: "2026-11-10", end_date: "2026-11-11", half_day: false, days: 2, status: type === "hr.leave.approved" ? "approved" : "cancelled", ...data,
      },
      ...event,
    },
    delivered_at: "2026-11-05T10:00:00Z",
  });
}

async function deliver(db: FakeSupabaseClient, body: string, delivery = `d-${++seq}`) {
  const type = JSON.parse(body).event.type;
  const signed = await signFigbloomWebhook(SECRET, body, NOW);
  return handle(new Request("https://schools.test/functions/v1/platform-events", {
    method: "POST", body,
    headers: { "x-figbloom-event": type, "x-figbloom-delivery": delivery, "x-figbloom-timestamp": signed.timestamp, "x-figbloom-signature": signed.signature },
  }), { admin: db, secret: SECRET, now: () => NOW });
}

const leave = (db: FakeSupabaseClient) => db.rowsIn("leave_requests");
const notices = (db: FakeSupabaseClient, to: string) => db.rowsIn("announcements").filter((a) => a.audience.user_id === to);
/** What cover planning reads (apps/web/src/lib/coverage.ts fetchTeachersOnLeaveForDate): approved leave on that day. */
const onLeave = (db: FakeSupabaseClient, date: string) =>
  new Set(leave(db).filter((l) => l.tenant_id === SCHOOL && l.status === "approved" && l.starts_on <= date && l.ends_on >= date).map((l) => l.teacher_id));

describe("platform-events: hr.leave.approved", () => {
  it("writes the leave as the office's approval does, so cover planning sees it, and sends the usual notice", async () => {
    const db = makeDb();
    const res = await deliver(db, leaveEvent("hr.leave.approved"), "d-a");
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals([out.applied, out.outcome], [true, "approved"]);
    const [row] = leave(db);
    assertEquals(leave(db).length, 1);
    assertEquals([row!.source, row!.hr_application_id, row!.status, row!.teacher_id, row!.starts_on, row!.ends_on], ["hr", "app-1", "approved", TEACHER, "2026-11-10", "2026-11-11"]);
    assertEquals([row!.hr_employee_number, row!.hr_leave_type, row!.days, row!.half_day], ["EMP-0007", "Annual leave", 2, false]);
    assert(onLeave(db, "2026-11-10").has(TEACHER));
    assert(onLeave(db, "2026-11-11").has(TEACHER));
    assertEquals(onLeave(db, "2026-11-12").size, 0);
    const [n] = notices(db, TEACHER);
    assertEquals([n!.subject, n!.body, n!.author_id, n!.channels], ["Your leave request was approved", "Your leave from 10 Nov to 11 Nov has been approved.", PRINCIPAL, ["in_app"]]);
    assertEquals(db.rowsIn("platform_event_deliveries").map((d) => [d.delivery_id, d.event_type, d.outcome]), [["d-a", "hr.leave.approved", "approved"]]);
    assertEquals(db.rowsIn("audit_events").length, 1);
  });

  it("idempotent per delivery: a retry is a duplicate, nothing twice", async () => {
    const db = makeDb();
    const body = leaveEvent("hr.leave.approved");
    await deliver(db, body, "d-same");
    const res = await deliver(db, body, "d-same");
    assertEquals((await res.json()).outcome, "duplicate");
    assertEquals(leave(db).length, 1);
    assertEquals(notices(db, TEACHER).length, 1);
  });

  it("idempotent per application: the same approval sent again (a new delivery) changes nothing and notifies no one", async () => {
    const db = makeDb();
    await deliver(db, leaveEvent("hr.leave.approved"));
    const res = await deliver(db, leaveEvent("hr.leave.approved"));
    assertEquals((await res.json()).outcome, "already_approved");
    assertEquals(leave(db).length, 1);
    assertEquals(notices(db, TEACHER).length, 1);
  });

  it("the person's own Schools request still waiting for those days gives way", async () => {
    const db = makeDb();
    db.seed("leave_requests", [{ id: "own", tenant_id: SCHOOL, teacher_id: TEACHER, starts_on: "2026-11-11", ends_on: "2026-11-12", status: "pending", source: "schools" }]);
    assertEquals((await deliver(db, leaveEvent("hr.leave.approved"))).status, 200);
    assertEquals(leave(db).find((l) => l.id === "own")!.status, "cancelled");
  });

  it("other approved leave on those days: refused (409 leave_overlaps), not recorded, so a person can fix it and the platform retry", async () => {
    const db = makeDb();
    db.seed("leave_requests", [{ id: "old", tenant_id: SCHOOL, teacher_id: TEACHER, starts_on: "2026-11-09", ends_on: "2026-11-10", status: "approved", source: "schools" }]);
    const res = await deliver(db, leaveEvent("hr.leave.approved"), "d-o");
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error.code, "leave_overlaps");
    assertEquals(leave(db).length, 1);
    assertEquals(db.rowsIn("platform_event_deliveries").length, 0);
    leave(db)[0]!.status = "cancelled";
    assertEquals((await deliver(db, leaveEvent("hr.leave.approved"), "d-o")).status, 200);
  });
});

describe("platform-events: hr.leave.cancelled", () => {
  it("cancels the leave, undoes the cover ahead (telling the substitute) and tells the person", async () => {
    const db = makeDb();
    await deliver(db, leaveEvent("hr.leave.approved"));
    db.seed("coverage_assignments", [
      { id: "c1", tenant_id: SCHOOL, date: "2026-11-10", class_id: CLASS, subject_id: MATHS, start_time: "08:00", absent_teacher_id: TEACHER, covering_teacher_id: SUB, assigned_by: PRINCIPAL },
      { id: "c2", tenant_id: SCHOOL, date: "2026-11-11", class_id: CLASS, subject_id: MATHS, start_time: "09:00", absent_teacher_id: TEACHER, covering_teacher_id: null, assigned_by: PRINCIPAL },
    ]);
    const res = await deliver(db, leaveEvent("hr.leave.cancelled"));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).outcome, "cancelled");
    assertEquals(leave(db)[0]!.status, "cancelled");
    assertEquals(onLeave(db, "2026-11-10").size, 0);
    assertEquals(db.rowsIn("coverage_assignments").length, 0);
    assertEquals(notices(db, SUB).map((n) => n.subject), ["Cover cancelled — Mathematics, Grade 6 East"]);
    assertEquals(notices(db, TEACHER).map((n) => n.subject), ["Your leave request was approved", "Your leave was cancelled"]);
  });

  it("cover already in the past is kept as the record", async () => {
    const db = makeDb();
    await deliver(db, leaveEvent("hr.leave.approved", { start_date: "2026-11-04", end_date: "2026-11-06" }));
    db.seed("coverage_assignments", [
      { id: "past", tenant_id: SCHOOL, date: "2026-11-04", class_id: CLASS, subject_id: MATHS, start_time: "08:00", absent_teacher_id: TEACHER, covering_teacher_id: SUB, assigned_by: PRINCIPAL },
      { id: "ahead", tenant_id: SCHOOL, date: "2026-11-06", class_id: CLASS, subject_id: MATHS, start_time: "08:00", absent_teacher_id: TEACHER, covering_teacher_id: SUB, assigned_by: PRINCIPAL },
    ]);
    await deliver(db, leaveEvent("hr.leave.cancelled", { start_date: "2026-11-04", end_date: "2026-11-06" }));
    assertEquals(db.rowsIn("coverage_assignments").map((c) => c.id), ["past"]);
  });

  it("a repeat of the cancel is already_cancelled; a cancel Schools never saw approved is kept, so a late approval is stale", async () => {
    const db = makeDb();
    await deliver(db, leaveEvent("hr.leave.approved"));
    await deliver(db, leaveEvent("hr.leave.cancelled", {}, { occurred_at: "2026-11-05T09:30:00Z" }));
    assertEquals((await (await deliver(db, leaveEvent("hr.leave.cancelled", {}, { occurred_at: "2026-11-05T09:30:00Z" }))).json()).outcome, "already_cancelled");

    const other = makeDb();
    let res = await deliver(other, leaveEvent("hr.leave.cancelled", {}, { occurred_at: "2026-11-05T09:30:00Z" }));
    assertEquals((await res.json()).outcome, "cancelled_unseen");
    res = await deliver(other, leaveEvent("hr.leave.approved", {}, { occurred_at: "2026-11-05T09:00:00Z" }));
    assertEquals((await res.json()).outcome, "stale");
    assertEquals(onLeave(other, "2026-11-10").size, 0);
    assertEquals(notices(other, TEACHER).length, 0);
  });
});

describe("platform-events: a date change (cancelled old + approved new, same application)", () => {
  const cancelOld = () => leaveEvent("hr.leave.cancelled", {}, { occurred_at: "2026-11-05T09:30:00Z" });
  const approveNew = () => leaveEvent("hr.leave.approved", { start_date: "2026-11-17", end_date: "2026-11-18" }, { occurred_at: "2026-11-05T09:30:00Z" });

  it("in order: the one row moves to the new dates", async () => {
    const db = makeDb();
    await deliver(db, leaveEvent("hr.leave.approved"));
    assertEquals((await (await deliver(db, cancelOld())).json()).outcome, "cancelled");
    assertEquals((await (await deliver(db, approveNew())).json()).outcome, "updated");
    assertEquals(leave(db).length, 1);
    assertEquals([leave(db)[0]!.status, leave(db)[0]!.starts_on, leave(db)[0]!.ends_on], ["approved", "2026-11-17", "2026-11-18"]);
    assertEquals(onLeave(db, "2026-11-10").size, 0);
    assert(onLeave(db, "2026-11-17").has(TEACHER));
  });

  it("the other way round: the late cancel names dates the row no longer has, and is stale", async () => {
    const db = makeDb();
    await deliver(db, leaveEvent("hr.leave.approved"));
    assertEquals((await (await deliver(db, approveNew())).json()).outcome, "updated");
    assertEquals((await (await deliver(db, cancelOld())).json()).outcome, "stale");
    assertEquals([leave(db)[0]!.status, leave(db)[0]!.starts_on], ["approved", "2026-11-17"]);
  });

  it("an event older than the last one applied is stale", async () => {
    const db = makeDb();
    await deliver(db, approveNew());
    const res = await deliver(db, leaveEvent("hr.leave.approved", {}, { occurred_at: "2026-11-05T09:00:00Z" }));
    assertEquals((await res.json()).outcome, "stale");
    assertEquals(leave(db)[0]!.starts_on, "2026-11-17");
  });
});

describe("platform-events: leave refusals and the switches", () => {
  it("refuses another school's person, an unknown person and a parent; changes nothing", async () => {
    const db = makeDb();
    assertEquals((await deliver(db, leaveEvent("hr.leave.approved", {}, { tenant_local_id: OTHER_SCHOOL }))).status, 403);
    assertEquals((await deliver(db, leaveEvent("hr.leave.approved", { external_id: "77777777-7777-4777-8777-777777777777" }))).status, 404);
    assertEquals((await deliver(db, leaveEvent("hr.leave.approved", { external_id: PARENT }))).status, 409);
    assertEquals(leave(db).length, 0);
    assertEquals(db.rowsIn("platform_event_deliveries").length, 0);
  });

  it("refuses a malformed leave event", async () => {
    const db = makeDb();
    for (const bad of [
      { application_id: null }, { application_id: "a b" }, { start_date: "10/11/2026" }, { end_date: "2026-11-09" },
      { half_day: "yes" }, { external_id: "TC-1" },
    ]) {
      assertEquals((await deliver(db, leaveEvent("hr.leave.approved", bad))).status, 400, JSON.stringify(bad));
    }
    assertEquals(leave(db).length, 0);
  });

  for (const [events, hrLeave] of [[false, true], [true, false]]) {
    it(`PLATFORM_EVENTS_ENABLED ${events ? "on" : "off"}, HR_LEAVE_ENABLED ${hrLeave ? "on" : "off"}: recorded and acknowledged, not applied`, async () => {
      const db = makeDb({ events, hrLeave });
      const res = await deliver(db, leaveEvent("hr.leave.approved"));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, applied: false, reason: "events_not_enabled" });
      assertEquals(leave(db).length, 0);
      assertEquals(db.rowsIn("platform_event_deliveries").map((d) => d.outcome), ["not_enabled"]);
    });
  }

  it("a database failure is a 500, so the platform retries", async () => {
    const db = makeDb();
    db.failNextRpc("connection reset");
    assertEquals((await deliver(db, leaveEvent("hr.leave.approved"), "d-r")).status, 500);
    assertEquals((await deliver(db, leaveEvent("hr.leave.approved"), "d-r")).status, 200);
  });
});

describe("Sketch's two days, end to end (the fake HR, my-hr and platform-events)", () => {
  it("apply in Schools -> the principal approves under Leave to approve -> on leave in Schools -> cancelled in HR -> gone", async () => {
    const db = makeDb();
    const hr = new FakeHr();
    hr.clock = () => NOW;
    hr.link(SCHOOL, "company");
    hr.hire("company", TEACHER, { number: "EMP-0007", name: "Sketch Kamau" });
    hr.hire("company", PRINCIPAL, { number: "EMP-0001", name: "Mary Principal" });
    hr.approverLink("company", PRINCIPAL, "hr-principal");
    hr.firstApprover.set("company", "hr-principal");
    const platform = new FakePlatform();
    const as = (id: string, approver: boolean) => {
      const asUser = new FakeSupabaseClient();
      asUser.authUser = { id, email: null };
      asUser.rpc = () => Promise.resolve({ data: { status: "available", approver }, error: null });
      return { admin: db, asUser, client: platform.client(), hrUrl: HR_BASE, fetch: hr.fetch };
    };
    const ask = async (deps: ReturnType<typeof as>, body: Row) => {
      const res = await myHr(new Request("https://s.test/my-hr", { method: "POST", headers: { Authorization: "Bearer x" }, body: JSON.stringify(body) }), deps);
      return { status: res.status, out: await res.json() };
    };
    // the relay: HR's outbox events, signed and delivered to platform-events
    const relay = async () => {
      for (const e of hr.events.splice(0)) {
        const body = JSON.stringify({ event: { type: e.type, id: e.id, occurred_at: e.occurred_at, source: "hr", tenant_local_id: e.school, data: e.data } });
        assertEquals((await deliver(db, body, `delivery-${e.id}`)).status, 200);
      }
    };

    let r = await ask(as(TEACHER, false), { route: "leave_apply", type_id: ANNUAL, start_date: "2026-11-12", end_date: "2026-11-13", reason: "My graduation ceremony" });
    assertEquals(r.status, 201);
    r = await ask(as(PRINCIPAL, true), { route: "approvals" });
    assertEquals(r.out.approvals.map((a: Row) => a.employee.name), ["Sketch Kamau"]);
    r = await ask(as(PRINCIPAL, true), { route: "approval_decide", application_id: r.out.approvals[0].application_id, decision: "approve" });
    assertEquals(r.status, 200);
    await relay();
    assert(onLeave(db, "2026-11-12").has(TEACHER));
    assert(onLeave(db, "2026-11-13").has(TEACHER));
    assertEquals(leave(db)[0]!.days, 2);
    assertEquals(notices(db, TEACHER).length, 1);

    hr.cancelInHr(hr.applications[0]!.id);
    await relay();
    assertEquals(onLeave(db, "2026-11-12").size, 0);
    await relay();  // nothing left: nothing changes
    assertEquals(leave(db).length, 1);
  });
});
