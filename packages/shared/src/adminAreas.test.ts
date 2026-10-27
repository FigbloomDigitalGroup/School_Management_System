import { describe, expect, it } from "vitest";
import {
  ADMIN_AREAS, ADMIN_AREA_INFO, ADMIN_PAGE_AREA, ADMIN_PRESETS, adminAccessFor, areasOfPresets, describeAreas,
  hasAdminConsole, isAdminArea, mayHoldAdminAreas, mayOpenAdminPage, presetsWithin, sortAreas, togglePreset,
} from "./adminAreas";
import { NAV } from "./auth";

describe("admin areas", () => {
  it("are the eleven the database knows (is_admin_area in 20261030000000)", () => {
    expect([...ADMIN_AREAS]).toEqual([
      "people", "fees", "academics", "attendance", "transport", "communication",
      "inventory", "activities", "visitors", "medical", "leave",
    ]);
    for (const a of ADMIN_AREAS) expect(ADMIN_AREA_INFO[a].allows.length).toBeGreaterThan(10);
  });
  it("never include settings: that stays with full admins", () => {
    expect(isAdminArea("settings")).toBe(false);
    expect(isAdminArea("fees")).toBe(true);
  });
  it("sort into one order, drop unknowns and repeats", () => {
    expect(sortAreas(["visitors", "fees", "nonsense", "fees", "people"])).toEqual(["people", "fees", "visitors"]);
  });
  it("read as a short list", () => {
    expect(describeAreas(["fees", "people"])).toBe("People, Fees");
    expect(describeAreas([])).toBe("No admin access");
  });
});

describe("presets", () => {
  it("are the jobs the user listed, each with known areas", () => {
    expect(ADMIN_PRESETS.map((p) => p.label)).toEqual([
      "Deputy principal", "Director of studies", "Secretary", "Bursar / accounts", "Operator / data clerk",
      "Receptionist", "Nurse / matron", "Transport manager", "Storekeeper", "Games / clubs master",
    ]);
    for (const p of ADMIN_PRESETS) for (const a of p.areas) expect(isAdminArea(a)).toBe(true);
  });
  it("give a deputy the running of the school, but not fees", () => {
    const deputy = areasOfPresets(["deputy"]);
    expect(deputy).toEqual(["people", "academics", "attendance", "communication", "activities", "leave"]);
    expect(deputy).not.toContain("fees");
  });
  it("give a bursar fees and nothing else", () => {
    expect(areasOfPresets(["bursar"])).toEqual(["fees"]);
  });
  it("combine as a union when someone holds several", () => {
    expect(areasOfPresets(["bursar", "secretary"])).toEqual(["people", "fees", "communication", "visitors"]);
  });
  it("show as on when every area is held, including smaller presets inside a bigger one", () => {
    const on = presetsWithin(areasOfPresets(["deputy"]));
    expect(on).toContain("deputy");
    expect(on).toContain("dos");
    expect(on).toContain("operator");
    expect(on).not.toContain("bursar");
  });
  it("add their areas when turned on", () => {
    expect(togglePreset(["fees"], "receptionist")).toEqual(["fees", "visitors"]);
  });
  it("take away only what no other held preset needs when turned off", () => {
    const deputyAndSecretary = areasOfPresets(["deputy", "secretary"]);
    expect(togglePreset(deputyAndSecretary, "secretary")).toEqual(areasOfPresets(["deputy"]));
    expect(togglePreset(deputyAndSecretary, "deputy")).toEqual(areasOfPresets(["secretary"]));
  });
  it("take the smaller presets inside them along when turned off", () => {
    expect(togglePreset(areasOfPresets(["deputy"]), "deputy")).toEqual([]);
    expect(togglePreset(areasOfPresets(["deputy", "bursar"]), "deputy")).toEqual(["fees"]);
  });
  it("leave a hand-ticked area alone", () => {
    expect(togglePreset(["fees", "transport"], "bursar")).toEqual(["transport"]);
  });
});

describe("who has the admin console", () => {
  it("is everything for full admins and an org admin acting for the school", () => {
    expect(adminAccessFor("school_admin", [])).toBe("all");
    expect(adminAccessFor("org_admin", [])).toBe("all");
    expect(adminAccessFor("teacher", ["fees"], true)).toBe("all");
  });
  it("is their areas for a teacher or other staff", () => {
    expect(adminAccessFor("teacher", ["fees", "people"])).toEqual(["people", "fees"]);
    expect(adminAccessFor("staff", ["visitors"])).toEqual(["visitors"]);
    expect(hasAdminConsole(adminAccessFor("teacher", []))).toBe(false);
  });
  it("is nothing for parents, learners and drivers, whatever a stray row says", () => {
    expect(adminAccessFor("parent", ["fees"])).toEqual([]);
    expect(adminAccessFor("driver", ["transport"])).toEqual([]);
    expect(mayHoldAdminAreas("student")).toBe(false);
    expect(mayHoldAdminAreas("teacher")).toBe(true);
  });
});

describe("admin pages", () => {
  it("each have an area or are marked full-admin or open", () => {
    for (const item of NAV.school_admin) expect(item.to in ADMIN_PAGE_AREA).toBe(true);
  });
  it("open exactly a bursar's areas", () => {
    const bursar = adminAccessFor("staff", ["fees"]);
    expect(mayOpenAdminPage(bursar, "admin/fees")).toBe(true);
    expect(mayOpenAdminPage(bursar, "admin")).toBe(true);
    expect(mayOpenAdminPage(bursar, "admin/account")).toBe(true);
    expect(mayOpenAdminPage(bursar, "admin/people")).toBe(false);
    expect(mayOpenAdminPage(bursar, "admin/exams")).toBe(false);
  });
  it("keep settings, reports and the assistant for full admins", () => {
    const deputy = adminAccessFor("teacher", areasOfPresets(["deputy"]));
    for (const page of ["admin/settings", "admin/reports", "admin/bloom", "admin/not-a-page"]) {
      expect(mayOpenAdminPage(deputy, page)).toBe(false);
      expect(mayOpenAdminPage("all", page)).toBe(true);
    }
  });
  it("are closed to a teacher without areas", () => {
    expect(mayOpenAdminPage([], "admin")).toBe(false);
    expect(mayOpenAdminPage([], "admin/account")).toBe(false);
  });
});
