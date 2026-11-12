import { describe, expect, it } from "vitest";
import { NAV } from "./auth";
import { groupNav } from "./navGroups";
import type { Role } from "./types";

const ROLES = Object.keys(NAV) as Role[];

describe("groupNav", () => {
  it("keeps every entry, in the order it was given: grouping hides nothing", () => {
    for (const role of ROLES) {
      const flat = groupNav(NAV[role]).flatMap((s) => s.items);
      expect(flat, role).toEqual(NAV[role]);
    }
  });

  it("starts a new run each time the heading changes", () => {
    const items: { to: string; group?: string }[] = [{ to: "a" }, { to: "b", group: "One" }, { to: "c", group: "One" }, { to: "d", group: "Two" }, { to: "e" }];
    expect(groupNav(items).map((s) => [s.label, s.items.map((i) => i.to)])).toEqual([
      [null, ["a"]], ["One", ["b", "c"]], ["Two", ["d"]], [null, ["e"]],
    ]);
  });

  it("joins two runs of one heading that a filtered-out entry used to separate", () => {
    const items = [{ to: "a", group: "One" }, { to: "b", group: "Two" }, { to: "c", group: "One" }];
    expect(groupNav(items.filter((i) => i.to !== "b")).map((s) => [s.label, s.items.length])).toEqual([["One", 2]]);
  });

  it("shows no heading for a group whose entries were all filtered out", () => {
    const items = [{ to: "a", group: "One" }, { to: "b", group: "Two" }, { to: "c", group: "Three" }];
    expect(groupNav(items.filter((i) => i.to !== "b")).map((s) => s.label)).toEqual(["One", "Three"]);
  });

  it("answers an empty list with no sections", () => {
    expect(groupNav([])).toEqual([]);
  });
});

describe("the console menus", () => {
  it("keep each heading's entries together: no heading appears twice in one menu", () => {
    for (const role of ROLES) {
      const labels = groupNav(NAV[role]).map((s) => s.label).filter((l): l is string => l !== null);
      expect(labels, role).toEqual([...new Set(labels)]);
    }
  });

  it("put the entries with no heading first, never between headings", () => {
    for (const role of ROLES) {
      const sections = groupNav(NAV[role]);
      const ungrouped = sections.map((s, i) => (s.label === null ? i : -1)).filter((i) => i >= 0);
      expect(ungrouped.every((i) => i === 0), role).toBe(true);
    }
  });

  it("never name a heading the same as one of its own menu's entries (two things reading alike)", () => {
    for (const role of ROLES) {
      const names = new Set(NAV[role].map((i) => i.label.toLowerCase()));
      for (const s of groupNav(NAV[role])) if (s.label) expect(names.has(s.label.toLowerCase()), `${role}: ${s.label}`).toBe(false);
    }
  });

  it("give the long menus headings (a school admin's runs to twenty-eight entries)", () => {
    for (const role of ["school_admin", "teacher", "parent", "student", "super_admin"] as Role[]) {
      expect(groupNav(NAV[role]).filter((s) => s.label !== null).length, role).toBeGreaterThanOrEqual(3);
    }
  });

  it("leave the short ones without (eight entries or fewer read fine as a plain list)", () => {
    for (const role of ["staff", "org_admin", "driver"] as Role[]) {
      expect(NAV[role].some((i) => i.group), role).toBe(false);
    }
  });

  it("keep Dashboard and the school assistant above the school admin's first heading", () => {
    const [first] = groupNav(NAV.school_admin);
    expect(first?.label).toBeNull();
    expect(first?.items.map((i) => i.to)).toEqual(["admin", "admin/assistant"]);
  });

  it("keep a bursar's pages together under Money", () => {
    const money = groupNav(NAV.school_admin).find((s) => s.label === "Money");
    expect(money?.items.map((i) => i.to)).toEqual(["admin/fees", "admin/study-helper"]);
  });

  it("never repeat a page within one menu", () => {
    for (const role of ROLES) {
      const tos = NAV[role].map((i) => i.to);
      expect(tos, role).toEqual([...new Set(tos)]);
    }
  });
});
