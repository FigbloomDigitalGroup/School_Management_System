import { assertEquals } from "jsr:@std/assert@1";
import { plan, type VisitRow } from "./plan.ts";

const base: VisitRow = {
  id: "v1", visitor_name: "Grace Atieno", purpose: "Fees query", host_kind: "office", host_id: null, student_name: null,
  escalated: false, status: "expected", host_pushed_at: null, escalation_pushed_at: null,
};

Deno.test("an office visit pushes nobody", () => {
  assertEquals(plan(base, ["a1"]), []);
});

Deno.test("a teacher's visitor is pushed to that teacher only", () => {
  const p = plan({ ...base, host_kind: "teacher", host_id: "t1" }, ["a1"]);
  assertEquals(p.map((x) => [x.marker, x.profileIds]), [["host_pushed_at", ["t1"]]]);
  assertEquals(p[0]!.title, "Grace Atieno is here to see you");
  assertEquals(p[0]!.body, "At the gate, on the way to the office. Fees query");
});

Deno.test("a visit for the principal goes to every admin", () => {
  const p = plan({ ...base, host_kind: "principal", escalated: true }, ["a1", "a2"]);
  assertEquals(p.map((x) => [x.marker, x.profileIds]), [["escalation_pushed_at", ["a1", "a2"]]]);
  assertEquals(p[0]!.title, "Grace Atieno is here to see the principal");
});

Deno.test("an escalated parent visit names the learner", () => {
  const p = plan({ ...base, host_kind: "learner", student_name: "Amani Otieno", escalated: true, status: "at_reception" }, ["a1"]);
  assertEquals(p[0]!.title, "Visitor escalated: Grace Atieno about Amani Otieno");
  assertEquals(p[0]!.body, "At the office. Fees query");
});

Deno.test("each audience is pushed once", () => {
  const v = { ...base, host_kind: "teacher" as const, host_id: "t1", escalated: true, host_pushed_at: "x" };
  assertEquals(plan(v, ["a1"]).map((x) => x.marker), ["escalation_pushed_at"]);
  assertEquals(plan({ ...v, escalation_pushed_at: "x" }, ["a1"]), []);
});

Deno.test("an admin who is the host isn't pushed twice", () => {
  const p = plan({ ...base, host_kind: "teacher", host_id: "a1", escalated: true }, ["a1"]);
  assertEquals(p.map((x) => x.marker), ["host_pushed_at"]);
});

Deno.test("nobody is pushed about a visitor who has left", () => {
  assertEquals(plan({ ...base, host_kind: "principal", escalated: true, status: "left" }, ["a1"]), []);
});
