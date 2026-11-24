import { describe, expect, it } from "vitest";
import { buildPlan, summarisePlan } from "./mapping.mjs";

const NOW = new Date("2026-11-23T09:00:00Z");
const T = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

function snapshot(over: Record<string, unknown[]> = {}) {
  return {
    organizations: [{ id: ORG, name: "Alliance Group" }],
    tenants: [
      {
        id: T, slug: "alliance", name: "Alliance High School", status: "active", organization_id: ORG, county: "Kiambu", country: "Kenya",
        level: "secondary", institution_type: "k12", moe_registration: "MOE/1", accent: "#0a7", timezone: "Africa/Nairobi",
      },
    ],
    terms: [
      { id: "t1", tenant_id: T, name: "Term 1, 2026", year: 2026, index: 1, starts_on: "2026-01-05", ends_on: "2026-04-03", is_current: false },
      { id: "t3", tenant_id: T, name: "Term 3, 2026", year: 2026, index: 3, starts_on: "2026-08-31", ends_on: "2026-11-27", is_current: true },
    ],
    classes: [
      { id: "c1", tenant_id: T, name: "Form 1 East", form_level: 1, stream: "East", class_teacher_id: "p-teacher", level: "secondary", pathway: null },
    ],
    profiles: [
      { id: "p-admin", tenant_id: T, role: "school_admin", full_name: "Amina Principal", email: "principal@alliance.test", phone: "0712345678", created_at: "2026-01-01" },
      { id: "p-teacher", tenant_id: T, role: "teacher", full_name: "Tom Teacher", email: null, phone: "0722000000", staff_title: "Maths", login_id: "TC-0001" },
      { id: "p-parent", tenant_id: T, role: "parent", full_name: "Mary Parent", email: "mary@example.com", phone: "0733000000", alt_phone: "0744000000" },
      { id: "p-student", tenant_id: T, role: "student", full_name: "Stu Dent" },
    ],
    students: [
      { id: "s1", tenant_id: T, admission_no: "A-001", full_name: "Ann One", gender: "female", boarding: true, active: true, class_id: "c1", date_of_birth: "2010-02-03" },
      { id: "s2", tenant_id: T, admission_no: "A-002", full_name: "Ben Two", gender: "M", boarding: false, active: true, class_id: "c1" },
    ],
    guardians: [
      { id: "g1", tenant_id: T, profile_id: "p-parent", student_id: "s1", relationship: "mother", is_primary_payer: true },
      { id: "g2", tenant_id: T, profile_id: "p-parent", student_id: "s2", relationship: "mother", is_primary_payer: false },
    ],
    ...over,
  };
}

const plan = (over?: Record<string, unknown[]>, options = {}) => buildPlan(snapshot(over), { now: NOW, ...options }).schools[0];

describe("school, years and terms", () => {
  it("builds one academic year from the terms, with the current term and year flagged", () => {
    const p = plan();
    expect(p.years).toHaveLength(1);
    expect(p.years[0].body).toEqual({ label: "2026", starts_on: "2026-01-05", ends_on: "2026-11-27", is_current: true });
    expect(p.terms.map((t: any) => [t.body.index, Boolean(t.body.is_current)])).toEqual([[1, false], [3, true]]);
  });

  it("blocks a term whose index the API cannot hold, or that repeats", () => {
    const p = plan({
      terms: [
        { id: "a", tenant_id: T, name: "T5", year: 2026, index: 5, starts_on: "2026-01-01", ends_on: "2026-02-01", is_current: false },
        { id: "b", tenant_id: T, name: "T1", year: 2026, index: 1, starts_on: "2026-01-01", ends_on: "2026-02-01", is_current: true },
        { id: "c", tenant_id: T, name: "T1 again", year: 2026, index: 1, starts_on: "2026-03-01", ends_on: "2026-04-01", is_current: false },
      ],
    });
    expect(p.terms).toHaveLength(1);
    expect(p.blocked.map((b: any) => b.sourceId).sort()).toEqual(["a", "c"]);
  });

  it("blocks classes and warns when there is no usable term, instead of inventing a year", () => {
    const p = plan({ terms: [] });
    expect(p.years).toHaveLength(0);
    expect(p.classes).toHaveLength(0);
    expect(p.blocked.some((b: any) => b.kind === "class")).toBe(true);
  });

  it("only sends a time zone when it is not the API's default", () => {
    expect(plan().profilePatch.timezone).toBeUndefined();
    const s = snapshot();
    (s.tenants[0] as any).timezone = "Africa/Kampala";
    expect(buildPlan(s, { now: NOW }).schools[0].profilePatch.timezone).toBe("Africa/Kampala");
  });

  it("blocks the school without a school administrator's email, and an override fixes that", () => {
    const profiles = snapshot().profiles.filter((p: any) => p.role !== "school_admin");
    expect(plan({ profiles }).blocked.some((b: any) => b.kind === "school")).toBe(true);
    const fixed = plan({ profiles }, { overrides: { schools: { alliance: { admin_email: "head@alliance.test" } } } });
    expect(fixed.blocked.some((b: any) => b.kind === "school")).toBe(false);
    expect(fixed.provision.admin_email).toBe("head@alliance.test");
  });
});

describe("learners", () => {
  it("never invents a gender: a learner without one is blocked, an override supplies it", () => {
    const students = [{ id: "s9", tenant_id: T, admission_no: "A-009", full_name: "No Gender", gender: null, boarding: false, active: true }];
    const blocked = plan({ students, guardians: [] });
    expect(blocked.learners).toHaveLength(0);
    expect(blocked.blocked[0].reason).toMatch(/gender/);
    const ok = plan({ students, guardians: [] }, { overrides: { learners: { "A-009": { gender: "female" } } } });
    expect(ok.learners[0].body.gender).toBe("female");
  });

  it("reads M/F spellings", () => {
    expect(plan().learners[1].body.gender).toBe("male");
  });

  it("blocks values the API refuses as spreadsheet formulas, and duplicate admission numbers", () => {
    const base = { tenant_id: T, gender: "male", boarding: false, active: true };
    const p = plan({
      students: [
        { ...base, id: "x1", admission_no: "=SUM(A1)", full_name: "Ok Name" },
        { ...base, id: "x2", admission_no: "A-100", full_name: "-Dash Start" },
        { ...base, id: "x3", admission_no: "A-200", full_name: "First" },
        { ...base, id: "x4", admission_no: "a-200 ", full_name: "Second" },
      ],
      guardians: [],
    });
    expect(p.learners.map((l: any) => l.key)).toEqual(["learner:x3"]);
    expect(p.blocked).toHaveLength(3);
  });

  it("leaves out a date of birth that is in the future (school-local) and warns", () => {
    const p = plan({
      students: [{ id: "s7", tenant_id: T, admission_no: "A-007", full_name: "Future Kid", gender: "male", boarding: false, active: true, date_of_birth: "2027-01-01" }],
      guardians: [],
    });
    expect(p.learners[0].body.date_of_birth).toBeUndefined();
    expect(p.warnings[0].message).toMatch(/future/);
  });

  it("carries the date of birth as the text Postgres wrote, and the class placement", () => {
    const l = plan().learners[0];
    expect(l.body).toMatchObject({ admission_no: "A-001", gender: "female", boarding: true, date_of_birth: "2010-02-03" });
    expect(l.classKey).toBe("class:c1");
  });

  it("marks inactive or archived learners to be archived at the end", () => {
    const p = plan({
      students: [
        { id: "s5", tenant_id: T, admission_no: "A-005", full_name: "Left School", gender: "male", boarding: false, active: false },
        { id: "s6", tenant_id: T, admission_no: "A-006", full_name: "Archived", gender: "male", boarding: false, active: true, archived_at: "2026-05-01" },
      ],
      guardians: [],
    });
    expect(p.learners.map((l: any) => l.archive)).toEqual([true, true]);
  });
});

describe("classes", () => {
  it("drops an education level that disagrees with the form level, a pathway outside senior school, and keeps the class", () => {
    const p = plan({
      classes: [
        { id: "k1", tenant_id: T, name: "Odd", form_level: 7, level: "secondary", pathway: "stem" },
        { id: "k2", tenant_id: T, name: "Senior", form_level: 11, level: "senior_school", pathway: "stem" },
      ],
    });
    expect(p.classes[0].body).toEqual({ name: "Odd", form_level: 7 });
    expect(p.classes[1].body).toEqual({ name: "Senior", form_level: 11, education_level: "senior_school", pathway: "stem" });
    expect(p.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("blocks a second class with the same name (the API needs it unique per year)", () => {
    const p = plan({
      classes: [
        { id: "k1", tenant_id: T, name: "Form 1", form_level: 1, level: "secondary" },
        { id: "k2", tenant_id: T, name: "form 1", form_level: 1, level: "secondary" },
      ],
    });
    expect(p.classes).toHaveLength(1);
    expect(p.blocked[0].sourceId).toBe("k2");
  });

  it("points the class teacher at the staff record, and leaves it unset with a warning if there is none", () => {
    expect(plan().classes[0].teacherStaffKey).toBe("staff:p-teacher");
    const p = plan({ classes: [{ id: "k1", tenant_id: T, name: "F", form_level: 1, level: "secondary", class_teacher_id: "someone-else" }] });
    expect(p.classes[0].teacherStaffKey).toBeNull();
    expect(p.warnings.some((w: any) => /class teacher/.test(w.message))).toBe(true);
  });
});

describe("staff", () => {
  it("takes school staff only, not parents or students, and keeps a guard's role as a title", () => {
    const p = plan({
      profiles: [
        ...snapshot().profiles,
        { id: "p-guard", tenant_id: T, role: "guard", full_name: "Gate Guard" },
        { id: "p-gone", tenant_id: T, role: "teacher", full_name: "Left Teacher", archived_at: "2026-03-01" },
      ],
    });
    expect(p.staff.map((s: any) => s.key)).toEqual(["staff:p-admin", "staff:p-teacher", "staff:p-guard", "staff:p-gone"]);
    expect(p.staff.find((s: any) => s.key === "staff:p-guard").body).toMatchObject({ classification: "staff", staff_title: "Guard" });
    expect(p.staff.find((s: any) => s.key === "staff:p-gone").archive).toBe(true);
  });

  it("leaves out a phone the API would refuse, and says so", () => {
    const p = plan({ profiles: [{ id: "p-t", tenant_id: T, role: "teacher", full_name: "Bad Phone", phone: "<script>" }] });
    expect(p.staff[0].body.phone).toBeUndefined();
    expect(p.warnings[0]).toMatchObject({ kind: "staff", sourceId: "p-t" });
  });
});

describe("guardians", () => {
  it("makes one guardian per parent profile, linked to each of their learners", () => {
    const g = plan().guardians;
    expect(g).toHaveLength(1);
    expect(g[0].body).toEqual({ full_name: "Mary Parent", phone: "0733000000", alt_phone: "0744000000", email: "mary@example.com" });
    expect(g[0].links.map((l: any) => [l.learnerKey, l.is_primary_payer])).toEqual([["learner:s1", true], ["learner:s2", false]]);
  });

  it("skips links to learners that are not copied, and blocks a guardian left with none", () => {
    const students = [{ id: "s1", tenant_id: T, admission_no: "A-001", full_name: "Ann One", gender: "female", boarding: false, active: true }];
    const one = plan({ students });
    expect(one.guardians[0].links).toHaveLength(1);
    const none = plan({ students: [] });
    expect(none.guardians).toHaveLength(0);
    expect(none.blocked.some((b: any) => b.kind === "guardian")).toBe(true);
  });
});

describe("the summary", () => {
  it("counts what would be created and carries no names", () => {
    const text = JSON.stringify(summarisePlan(buildPlan(snapshot(), { now: NOW })));
    expect(JSON.parse(text)[0].toCreate).toMatchObject({ learners: 2, class_placements: 2, guardians: 1, guardian_links: 2, staff: 2, classes: 1 });
    for (const name of ["Ann One", "Mary Parent", "Tom Teacher", "Amina Principal"]) expect(text).not.toContain(name);
  });

  it("counts what has nowhere to go in the API", () => {
    const p = plan({
      students: [{ id: "s1", tenant_id: T, admission_no: "A-001", full_name: "Ann One", gender: "female", boarding: false, active: true, home_address: "x", upi_no: "u" }],
      guardians: [],
    });
    expect(p.notCarried).toMatchObject({ learner_address_or_location: 1, learner_identity_numbers: 1, people_with_logins: 1 });
  });
});
