import { describe, expect, it } from "vitest";
import { NAV } from "./auth";
import { adminAccessFor } from "./adminAreas";
import { STAFF_TITLE_SUGGESTIONS } from "./otherStaff";

describe("the visitor log", () => {
  it("is the visitors admin area now, not a flag on the profile (20261030000000)", () => {
    expect(adminAccessFor("staff", ["visitors"])).toEqual(["visitors"]);
    expect(adminAccessFor("staff", [])).toEqual([]);
    // a teacher can hold it too now; parents and drivers never can
    expect(adminAccessFor("teacher", ["visitors"])).toEqual(["visitors"]);
    expect(adminAccessFor("driver", ["visitors"])).toEqual([]);
  });
});

describe("the other staff console", () => {
  it("has notices, chats, items and the account, plus Visitors (hidden without the visitors area)", () => {
    expect(NAV.staff.map((i) => i.to)).toEqual(["staff/visitors", "staff/notices", "staff/chats", "staff/items", "staff/account"]);
  });
  it("suggests the jobs the gate and reception accounts became", () => {
    expect(STAFF_TITLE_SUGGESTIONS).toContain("Guard");
    expect(STAFF_TITLE_SUGGESTIONS).toContain("Receptionist");
  });
});
