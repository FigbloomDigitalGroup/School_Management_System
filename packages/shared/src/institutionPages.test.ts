import { describe, expect, it } from "vitest";
import { HIGHER_ED_ONLY_PAGES, K12_ONLY_PAGES, pageIsNotForInstitution, pageOfPath } from "./institutionPages";
import { NAV, homeRouteFor } from "./auth";
import type { InstitutionType, Role } from "./types";

describe("pageIsNotForInstitution", () => {
  it("a higher-education school has none of the K-12 screens, by address", () => {
    for (const page of ["admin/classes", "admin/subjects", "admin/exams", "admin/papers", "admin/report-cards", "teacher/classes", "teacher/attendance", "teacher/timetable", "teacher/homework", "student/exams", "parent/materials"]) {
      expect(pageIsNotForInstitution(page, "higher_ed"), page).toBe(true);
      expect(pageIsNotForInstitution(page, "k12"), page).toBe(false);
    }
  });

  it("a K-12 school has none of the higher-education screens, by address", () => {
    for (const page of ["admin/courses", "teacher/sections"]) {
      expect(pageIsNotForInstitution(page, "k12"), page).toBe(true);
      expect(pageIsNotForInstitution(page, "higher_ed"), page).toBe(false);
    }
  });

  it("the screens both kinds use are never held back", () => {
    for (const page of ["admin", "admin/people", "admin/fees", "admin/settings", "admin/leave", "teacher/gradebook", "teacher/leave", "parent", "parent/fees", "parent/results", "student", "student/results", "driver", "staff"]) {
      expect(pageIsNotForInstitution(page, "k12"), page).toBe(false);
      expect(pageIsNotForInstitution(page, "higher_ed"), page).toBe(false);
    }
  });

  it("a screen under a held-back one is held back too, but a name that only starts the same is not", () => {
    expect(pageIsNotForInstitution("admin/classes/abc-123", "higher_ed")).toBe(true);
    expect(pageIsNotForInstitution("admin/classes-archive", "higher_ed")).toBe(false);
    expect(pageIsNotForInstitution("admin/courses/abc-123", "k12")).toBe(true);
    expect(pageIsNotForInstitution("admin/coursework", "k12")).toBe(false);
  });

  it("every menu item the sidebar hides is held back by address, and nothing is in both lists", () => {
    const hiddenSomewhere = new Set([...K12_ONLY_PAGES, ...HIGHER_ED_ONLY_PAGES]);
    expect(K12_ONLY_PAGES.filter((p) => HIGHER_ED_ONLY_PAGES.includes(p))).toEqual([]);
    for (const role of Object.keys(NAV) as Role[]) {
      for (const item of NAV[role]) {
        // the menu and the router read the same two lists, so an item is either in one of them or shown to both kinds
        const heldFor = (["k12", "higher_ed"] as InstitutionType[]).filter((t) => pageIsNotForInstitution(item.to, t));
        expect(heldFor.length <= 1, `${role} ${item.to}`).toBe(true);
        expect(hiddenSomewhere.has(item.to), `${role} ${item.to}`).toBe(heldFor.length === 1);
      }
    }
  });

  it("nobody is sent home to a screen that is held back from them (no redirect loop)", () => {
    const roles: Role[] = ["school_admin", "teacher", "parent", "student", "driver", "staff"];
    for (const type of ["k12", "higher_ed"] as InstitutionType[]) {
      for (const role of roles) {
        const home = homeRouteFor(role, "alliance", type);
        const page = pageOfPath(home, "alliance");
        expect(page, `${role} ${type} ${home}`).not.toBeNull();
        expect(pageIsNotForInstitution(page!, type), `${role} ${type} ${home}`).toBe(false);
      }
    }
  });
});

describe("pageOfPath", () => {
  it("reads the page of an address inside the school, whatever follows it", () => {
    expect(pageOfPath("/s/alliance/admin/classes", "alliance")).toBe("admin/classes");
    expect(pageOfPath("/s/alliance/admin/classes/", "alliance")).toBe("admin/classes");
    expect(pageOfPath("/s/alliance/admin", "alliance")).toBe("admin");
  });

  it("is null for an address that is not this school's", () => {
    expect(pageOfPath("/s/other/admin/classes", "alliance")).toBeNull();
    expect(pageOfPath("/platform/tenants", "alliance")).toBeNull();
    expect(pageOfPath("/s/alliance", "alliance")).toBeNull();
  });
});
