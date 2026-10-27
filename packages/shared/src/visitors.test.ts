import { describe, expect, it } from "vitest";
import { escalatesOnArrival, nextVisitSteps, visitAlert, visitDraftProblem, visitHostLabel, visitQueue, type Visit } from "./visitors";

const visit = (over: Partial<Visit> = {}): Visit => ({
  id: "v1", tenant_id: "t1", visitor_name: "Grace Atieno", visitor_phone: null, id_number: null, vehicle_plate: null,
  purpose: "Fees query", host_kind: "office", host_id: null, student_id: null, host_name: null, student_name: null,
  entry_point: "gate", status: "expected", escalated: false, escalated_at: null, note: null, recorded_by: "g1",
  arrived_at: "2026-10-27T07:00:00Z", reception_at: null, with_host_at: null, left_at: null, updated_at: "2026-10-27T07:00:00Z",
  ...over,
});

describe("visitDraftProblem", () => {
  const ok = { visitor_name: "Grace", purpose: "Fees", host_kind: "office" as const };
  it("accepts a complete draft", () => expect(visitDraftProblem(ok)).toBeNull());
  it("needs a name and a reason", () => {
    expect(visitDraftProblem({ ...ok, visitor_name: "  " })).toBe("Enter the visitor's name.");
    expect(visitDraftProblem({ ...ok, purpose: "" })).toBe("Say why they've come.");
  });
  it("needs the staff member or learner the visit is for", () => {
    expect(visitDraftProblem({ ...ok, host_kind: "teacher" })).toBe("Pick who they've come to see.");
    expect(visitDraftProblem({ ...ok, host_kind: "teacher", host_id: "t1" })).toBeNull();
    expect(visitDraftProblem({ ...ok, host_kind: "learner" })).toBe("Pick the learner they've come about.");
  });
});

describe("escalation and labels", () => {
  it("escalates only visits for the principal on arrival", () => {
    expect(escalatesOnArrival("principal")).toBe(true);
    expect(escalatesOnArrival("teacher")).toBe(false);
    expect(escalatesOnArrival("learner")).toBe(false);
  });
  it("says who the visit is for", () => {
    expect(visitHostLabel(visit({ host_kind: "teacher", host_name: "Mr Otieno" }))).toBe("Mr Otieno");
    expect(visitHostLabel(visit({ host_kind: "learner", student_name: "Amani" }))).toBe("about Amani");
    expect(visitHostLabel(visit({ host_kind: "principal" }))).toBe("the principal");
  });
});

describe("nextVisitSteps", () => {
  it("lets the guard only sign visitors out", () => {
    expect(nextVisitSteps("expected", "guard")).toEqual(["left"]);
  });
  it("moves reception's queue forward", () => {
    expect(nextVisitSteps("expected", "receptionist")).toEqual(["at_reception", "left"]);
    expect(nextVisitSteps("at_reception", "receptionist")).toEqual(["with_host", "left"]);
    expect(nextVisitSteps("with_host", "receptionist")).toEqual(["left"]);
    expect(nextVisitSteps("left", "receptionist")).toEqual([]);
  });
});

describe("visitQueue", () => {
  it("drops those who left and puts escalated visits first, then oldest first", () => {
    const q = visitQueue([
      visit({ id: "a", arrived_at: "2026-10-27T07:05:00Z" }),
      visit({ id: "b", arrived_at: "2026-10-27T07:01:00Z" }),
      visit({ id: "c", status: "left" }),
      visit({ id: "d", escalated: true, arrived_at: "2026-10-27T07:09:00Z" }),
    ]);
    expect(q.map((v) => v.id)).toEqual(["d", "b", "a"]);
  });
});

describe("visitAlert", () => {
  const teacher = { profileId: "t1", role: "teacher" as const };
  const admin = { profileId: "a1", role: "school_admin" as const };

  it("tells the host when their visitor is recorded, once", () => {
    const v = visit({ host_kind: "teacher", host_id: "t1" });
    expect(visitAlert(v, teacher, true)?.title).toBe("Grace Atieno is here to see you");
    expect(visitAlert({ ...v, status: "at_reception", updated_at: "x" }, teacher, false)).toBeNull();
    expect(visitAlert(v, { profileId: "t2", role: "teacher" }, true)).toBeNull();
  });

  it("tells admins about a visit for the principal", () => {
    const v = visit({ host_kind: "principal", escalated: true, escalated_at: "2026-10-27T07:00:00Z" });
    expect(visitAlert(v, admin, true)?.title).toBe("Grace Atieno is here to see the principal");
    expect(visitAlert(v, teacher, true)).toBeNull();
  });

  it("tells admins when reception escalates, but not on later steps", () => {
    const at = "2026-10-27T07:12:00Z";
    const escalated = visit({ host_kind: "learner", student_name: "Amani", status: "at_reception", escalated: true, escalated_at: at, updated_at: at });
    expect(visitAlert(escalated, admin, false)?.title).toBe("Visitor escalated: Grace Atieno about Amani");
    expect(visitAlert({ ...escalated, status: "with_host", updated_at: "2026-10-27T07:20:00Z" }, admin, false)).toBeNull();
  });

  it("is quiet about visitors who have left", () => {
    expect(visitAlert(visit({ host_id: "t1", status: "left" }), teacher, true)).toBeNull();
  });
});
