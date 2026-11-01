import { describe, expect, it } from "vitest";
import { auditChanges, auditValue } from "./audit";

describe("auditChanges", () => {
  it("reads the generic trigger's per-record changes", () => {
    expect(auditChanges({
      table: "classes", op: "update",
      changes: [{ key: { id: "c1" }, changes: { name: { from: "Form 1", to: "Form 2" }, class_teacher_id: { from: null, to: "t1" } } }],
    })).toEqual([
      { record: "c1", field: "name", from: "Form 1", to: "Form 2", hidden: false },
      { record: "c1", field: "class teacher id", from: null, to: "t1", hidden: false },
    ]);
  });

  it("names a record with a composite key by all its parts", () => {
    expect(auditChanges({ changes: [{ key: { profile_id: "p1", area: "fees" }, changes: { granted_by: { from: "a", to: "b" } } }] })[0]!.record)
      .toBe("p1 · fees");
  });

  it("marks a value kept out of the log as hidden", () => {
    expect(auditChanges({ changes: [{ key: { id: "l1" }, changes: { reason: null } }] }))
      .toEqual([{ record: "l1", field: "reason", from: null, to: null, hidden: true }]);
  });

  it("reads the fee triggers' single-record changes", () => {
    expect(auditChanges({ invoice_id: "i1", changes: { due_on: { from: "2027-01-05", to: "2027-01-12" } } }))
      .toEqual([{ record: null, field: "due on", from: "2027-01-05", to: "2027-01-12", hidden: false }]);
  });

  it("has nothing to list for an event a function worded itself", () => {
    expect(auditChanges({ student_ids: ["s1"], names: ["Faith"] })).toEqual([]);
    expect(auditChanges(null)).toEqual([]);
  });
});

describe("auditValue", () => {
  it("shows text as it is, nothing as a dash, and anything else as JSON", () => {
    expect(auditValue("Form 2")).toBe("Form 2");
    expect(auditValue(null)).toBe("—");
    expect(auditValue("")).toBe("—");
    expect(auditValue(4500000)).toBe("4500000");
    expect(auditValue({ a: 1 })).toBe('{"a":1}');
  });
});
