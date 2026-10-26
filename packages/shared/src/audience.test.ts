import { describe, expect, it } from "vitest";
import { audienceIncludes, audienceLabel, STAFF_ROLES, type AudienceViewer } from "./audience";
import { reachOf, searchRoster, teacherPickablePeople, type RosterPerson } from "./messageRoster";
import type { Audience } from "./types";

const parent: AudienceViewer = { profileId: "p1", role: "parent", classIds: ["c-f2w"], years: [{ level: "secondary", year: 2 }] };
const student: AudienceViewer = { profileId: "s1", role: "student", classIds: ["c-f2w"], years: [{ level: "secondary", year: 2 }] };
const teacher: AudienceViewer = { profileId: "t1", role: "teacher", classIds: [], years: [] };
const admin: AudienceViewer = { profileId: "a1", role: "school_admin", classIds: [], years: [] };
const driver: AudienceViewer = { profileId: "d1", role: "driver", classIds: [], years: [] };

const allStaff: Audience = { kind: "roles", roles: STAFF_ROLES };

describe("audienceIncludes", () => {
  it("whole_school reaches everyone", () => {
    for (const v of [parent, student, teacher, admin, driver]) expect(audienceIncludes({ kind: "whole_school" }, v)).toBe(true);
  });

  it("role reaches only that role", () => {
    expect(audienceIncludes({ kind: "role", role: "teacher" }, teacher)).toBe(true);
    expect(audienceIncludes({ kind: "role", role: "teacher" }, parent)).toBe(false);
    expect(audienceIncludes({ kind: "role", role: "student" }, student)).toBe(true);
    expect(audienceIncludes({ kind: "role", role: "student" }, parent)).toBe(false);
  });

  it("roles: all staff reaches admins, teachers, drivers and the front desk, never parents or students", () => {
    expect(audienceIncludes(allStaff, teacher)).toBe(true);
    expect(audienceIncludes(allStaff, admin)).toBe(true);
    expect(audienceIncludes(allStaff, driver)).toBe(true);
    expect(audienceIncludes(allStaff, { profileId: "g1", role: "guard", classIds: [], years: [] })).toBe(true);
    expect(audienceIncludes(allStaff, parent)).toBe(false);
    expect(audienceIncludes(allStaff, student)).toBe(false);
  });

  it("class respects recipients, and omitted recipients means both", () => {
    const c = (recipients?: "guardians" | "students" | "both"): Audience => ({ kind: "class", class_id: "c-f2w", recipients });
    expect(audienceIncludes(c("guardians"), parent)).toBe(true);
    expect(audienceIncludes(c("guardians"), student)).toBe(false);
    expect(audienceIncludes(c("students"), student)).toBe(true);
    expect(audienceIncludes(c("students"), parent)).toBe(false);
    expect(audienceIncludes(c(), parent)).toBe(true);
    expect(audienceIncludes(c(), student)).toBe(true);
    expect(audienceIncludes(c("both"), student)).toBe(true);
  });

  it("class never reaches a different class, or staff", () => {
    expect(audienceIncludes({ kind: "class", class_id: "c-other" }, parent)).toBe(false);
    expect(audienceIncludes({ kind: "class", class_id: "c-f2w" }, { ...teacher, classIds: ["c-f2w"] })).toBe(false);
  });

  it("form_level reaches students as well as parents, and respects recipients", () => {
    expect(audienceIncludes({ kind: "form_level", form_level: 2, level: "secondary" }, student)).toBe(true);
    expect(audienceIncludes({ kind: "form_level", form_level: 2, level: "secondary" }, parent)).toBe(true);
    expect(audienceIncludes({ kind: "form_level", form_level: 2, level: "secondary", recipients: "students" }, parent)).toBe(false);
    expect(audienceIncludes({ kind: "form_level", form_level: 2, level: "secondary", recipients: "guardians" }, student)).toBe(false);
    expect(audienceIncludes({ kind: "form_level", form_level: 2 }, teacher)).toBe(false);
  });

  it("form_level tells Grade 2 from Form 2, but an old level-less one matches either", () => {
    expect(audienceIncludes({ kind: "form_level", form_level: 2, level: "primary" }, parent)).toBe(false);
    expect(audienceIncludes({ kind: "form_level", form_level: 2 }, parent)).toBe(true);
    expect(audienceIncludes({ kind: "form_level", form_level: 3 }, parent)).toBe(false);
  });

  it("user and people reach exactly the named profiles, whatever their role", () => {
    expect(audienceIncludes({ kind: "user", user_id: "t1" }, teacher)).toBe(true);
    expect(audienceIncludes({ kind: "user", user_id: "t1" }, admin)).toBe(false);
    const people: Audience = { kind: "people", profile_ids: ["p1", "t1"] };
    expect(audienceIncludes(people, parent)).toBe(true);
    expect(audienceIncludes(people, teacher)).toBe(true);
    expect(audienceIncludes(people, student)).toBe(false);
    expect(audienceIncludes(people, admin)).toBe(false);
  });

  it("a missing or unknown audience reaches nobody", () => {
    expect(audienceIncludes(null, parent)).toBe(false);
    expect(audienceIncludes({ kind: "galaxy" } as unknown as Audience, parent)).toBe(false);
  });
});

describe("audienceLabel", () => {
  it("names role groups in plain words", () => {
    expect(audienceLabel({ kind: "role", role: "teacher" })).toBe("All teachers");
    expect(audienceLabel(allStaff)).toBe("All staff");
    // sent before the front desk had accounts
    expect(audienceLabel({ kind: "roles", roles: ["school_admin", "teacher", "driver"] })).toBe("All staff");
    expect(audienceLabel({ kind: "roles", roles: ["school_admin", "teacher"] })).toBe("All admins and teachers");
  });

  it("counts people, or names the one person when it can", () => {
    expect(audienceLabel({ kind: "people", profile_ids: ["a", "b", "c"] })).toBe("3 people");
    expect(audienceLabel({ kind: "people", profile_ids: ["a"] }, { personName: () => "Mary Wanjiku" })).toBe("Mary Wanjiku");
  });

  it("says who in a class or year group", () => {
    expect(audienceLabel({ kind: "class", class_id: "c1", recipients: "students" }, { className: () => "Form 2 West" })).toBe("Students of Form 2 West");
    expect(audienceLabel({ kind: "form_level", form_level: 7, level: "junior_secondary" })).toBe("Parents and students of Grade 7");
  });
});

function person(profileId: string, role: RosterPerson["role"], name: string, classIds: string[] = [], detail = ""): RosterPerson {
  return { profileId, name, role, detail, viewer: { profileId, role, classIds, years: [] } };
}

describe("roster helpers", () => {
  const people = [
    person("t1", "teacher", "Grace Achieng"),
    person("t2", "teacher", "John Kamau"),
    person("a1", "school_admin", "Principal Otieno"),
    person("p1", "parent", "Mary Wanjiku", ["c1"], "Parent of Amani (Form 2 West)"),
    person("p2", "parent", "Peter Mwangi", ["c9"], "Parent of Zawadi (Form 4 East)"),
    person("s1", "student", "Amani Wanjiku", ["c1"], "Student, Form 2 West"),
  ];

  it("reachOf counts with the same rule the inboxes use", () => {
    expect(reachOf({ kind: "whole_school" }, people)).toBe(6);
    expect(reachOf({ kind: "role", role: "teacher" }, people)).toBe(2);
    expect(reachOf({ kind: "class", class_id: "c1", recipients: "guardians" }, people)).toBe(1);
    expect(reachOf({ kind: "class", class_id: "c1" }, people)).toBe(2);
  });

  it("a teacher can pick fellow staff and their own classes' families, not other classes or themselves", () => {
    const ids = teacherPickablePeople(people, "t1", ["c1"]).map((p) => p.profileId);
    expect(ids).toEqual(["t2", "a1", "p1", "s1"]);
  });

  it("search matches every word against name and detail", () => {
    expect(searchRoster(people, "wanjiku").map((p) => p.profileId)).toEqual(["p1", "s1"]);
    expect(searchRoster(people, "form 2 west parent").map((p) => p.profileId)).toEqual(["p1"]);
    expect(searchRoster(people, "   ")).toEqual([]);
  });
});
