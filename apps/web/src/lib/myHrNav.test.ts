import { describe, expect, it } from "vitest";
import { isMyHrNav, showsMyHrEntry } from "./myHrNav";

describe("which sidebar entries are My HR", () => {
  it("the three consoles' entries, and nothing else", () => {
    for (const to of ["teacher/my-hr", "staff/my-hr", "admin/my-hr"]) expect(isMyHrNav(to), to).toBe(true);
    for (const to of ["admin/leave", "teacher/leave", "staff/loans", "admin/my-hr/x", "teacher/my-hr-extra", "my-hrs", "parent/account"]) expect(isMyHrNav(to), to).toBe(false);
  });
});

describe("when a My HR entry shows on the API build", () => {
  it("never until the status says available", () => {
    for (const to of ["teacher/my-hr", "staff/my-hr", "admin/my-hr"]) {
      expect(showsMyHrEntry({ to, available: false, role: "school_admin", acting: false }), to).toBe(false);
    }
  });

  it("the teacher and staff entries show for their person once it is available", () => {
    expect(showsMyHrEntry({ to: "teacher/my-hr", available: true, role: "teacher", acting: false })).toBe(true);
    expect(showsMyHrEntry({ to: "staff/my-hr", available: true, role: "staff", acting: false })).toBe(true);
  });

  it("the admin entry is the school's own administrator's: not a teacher or staff member with areas, not an acting org admin", () => {
    expect(showsMyHrEntry({ to: "admin/my-hr", available: true, role: "school_admin", acting: false })).toBe(true);
    expect(showsMyHrEntry({ to: "admin/my-hr", available: true, role: "school_admin", acting: true })).toBe(false);
    for (const role of ["teacher", "staff", "org_admin", "super_admin", "parent", null, undefined]) {
      expect(showsMyHrEntry({ to: "admin/my-hr", available: true, role, acting: false }), String(role)).toBe(false);
    }
  });
});
