import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeSupabase as db } from "./testing/fakeSupabase";

vi.mock("./supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: () => fakeSupabase.client };
});

import { addLearner, fetchPeopleRoster, reviewStaffPhoto, setTeacherQualified, updateLearnerDetails, updateStaffDetails } from "./peopleRoster";

const pad = (i: number) => String(i).padStart(5, "0");

beforeEach(() => db.reset());

describe("the roster", () => {
  it("reads every active learner past the first 1,000, with their login and this term's invoice", async () => {
    db.tables.terms = [{ id: "t-old", tenant_id: "s1", is_current: false }, { id: "t-now", tenant_id: "s1", is_current: true }];
    db.tables.students = Array.from({ length: 1_512 }, (_, i) => ({
      id: `st${pad(i)}`, tenant_id: "s1", active: true, full_name: `Learner ${pad(i)}`, admission_no: `A${i}`, gender: "female",
      class_id: "c1", boarding: false, avatar_url: null, profile_id: `p${pad(i)}`,
    }));
    db.tables.students.push({ id: "left", tenant_id: "s1", active: false, full_name: "Gone", profile_id: null });
    db.tables.profiles = [
      ...Array.from({ length: 1_512 }, (_, i) => ({ id: `p${pad(i)}`, tenant_id: "s1", role: "student", login_id: `L${pad(i)}` })),
      { id: "teach", tenant_id: "s1", role: "teacher", full_name: "Tom", login_id: "T1" },
      { id: "par", tenant_id: "s1", role: "parent", full_name: "Pat", login_id: "P1" },
    ];
    db.tables.fee_invoices = [
      { id: "i1", tenant_id: "s1", term_id: "t-now", student_id: "st01500", total_cents: 900_000, paid_cents: 300_000 },
      { id: "i0", tenant_id: "s1", term_id: "t-old", student_id: "st01500", total_cents: 1, paid_cents: 1 },
    ];
    db.tables.teacher_subjects = [
      { tenant_id: "s1", teacher_id: "teach", subject_id: "math" }, { tenant_id: "s1", teacher_id: "teach", subject_id: "chem" },
    ];

    const roster = await fetchPeopleRoster("s1");
    expect(roster.students).toHaveLength(1_512);
    expect(roster.students.find((s) => s.id === "st01511")).toMatchObject({ login_id: "L01511" });
    expect(roster.staff.map((s) => s.id)).toEqual(["teach"]);
    expect(roster.feeByStudent.get("st01500")).toEqual({ total: 900_000, paid: 300_000 });
    expect(roster.feeByStudent.size).toBe(1);
    expect(roster.subjectIdsByTeacher.get("teach")).toEqual(["math", "chem"]);
  });

  it("shows no balances when the school has no current term", async () => {
    db.tables.fee_invoices = [{ id: "i1", tenant_id: "s1", term_id: "t1", student_id: "a", total_cents: 5, paid_cents: 0 }];
    const roster = await fetchPeopleRoster("s1");
    expect(roster.feeByStudent.size).toBe(0);
  });

  it("throws when any part fails, rather than showing an empty list", async () => {
    db.error.profiles = 'column profiles.handles_visitors does not exist';
    await expect(fetchPeopleRoster("s1")).rejects.toThrow("handles_visitors");
  });
});

describe("edits from the People screen", () => {
  it("admits a learner as active, with their home, and gives back the new id", async () => {
    db.inserted.students = { id: "new-1" };
    const id = await addLearner({
      tenantId: "s1", admissionNo: "A9", fullName: "Ann Wanjiru", gender: "female", classId: "c1", boarding: false, dateOfBirth: null,
      home: { address: "Ruiru", landmark: null, lat: -1.15, lng: 36.96 },
    });
    expect(id).toBe("new-1");
    expect(db.calls.inserts).toEqual([{ table: "students", row: {
      tenant_id: "s1", admission_no: "A9", full_name: "Ann Wanjiru", gender: "female", class_id: "c1", boarding: false, date_of_birth: null,
      active: true, home_address: "Ruiru", home_landmark: null, home_lat: -1.15, home_lng: 36.96,
    } }]);
  });

  it("saves learner and staff details to the one row named", async () => {
    await updateLearnerDetails("st1", { fullName: "Ann W", admissionNo: "A9", gender: null, classId: null, boarding: true });
    await updateStaffDetails("pr1", { fullName: "Esther A", staffTitle: "Librarian", phone: null });
    expect(db.calls.updates).toEqual([
      { table: "students", patch: { full_name: "Ann W", admission_no: "A9", gender: null, class_id: null, boarding: true }, filters: [["id", "st1"]] },
      { table: "profiles", patch: { full_name: "Esther A", staff_title: "Librarian", phone: null }, filters: [["id", "pr1"]] },
    ]);
  });

  it("keeping a changed photo clears the flag; removing it clears the photo", async () => {
    await reviewStaffPhoto("drv", false);
    await reviewStaffPhoto("drv", true);
    expect(db.calls.updates.map((u) => u.patch)).toEqual([{ photo_changed_at: null }, { avatar_url: null }]);
  });

  it("adds and removes a teacher's subject qualification", async () => {
    await setTeacherQualified({ tenantId: "s1", teacherId: "t", subjectId: "math", qualified: true });
    await setTeacherQualified({ tenantId: "s1", teacherId: "t", subjectId: "math", qualified: false });
    expect(db.calls.inserts).toEqual([{ table: "teacher_subjects", row: { tenant_id: "s1", teacher_id: "t", subject_id: "math" } }]);
    expect(db.calls.deletes).toEqual([{ table: "teacher_subjects", filters: [["teacher_id", "t"], ["subject_id", "math"]] }]);
  });

  it("throws when a write is refused", async () => {
    db.error.students = "duplicate key value violates unique constraint";
    await expect(updateLearnerDetails("st1", { fullName: "x", admissionNo: "A1", gender: null, classId: null, boarding: false })).rejects.toThrow("duplicate key");
    await expect(addLearner({ tenantId: "s1", admissionNo: "A1", fullName: "x", gender: "male", classId: "c", boarding: false, dateOfBirth: null, home: { address: null, landmark: null, lat: null, lng: null } }))
      .rejects.toThrow("duplicate key");
  });
});
