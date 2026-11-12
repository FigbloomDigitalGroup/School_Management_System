import { describe, expect, it } from "vitest";
import { orgAdminRemovedNote, removeOrgAdminQuestion, removeSchoolAdminQuestion, schoolAdminTitle } from "./adminAccounts";

describe("removeSchoolAdminQuestion", () => {
  it("names the person and the school, and says it cannot be undone", () => {
    const q = removeSchoolAdminQuestion("Grace Wambui", "Riverside Primary", false);
    expect(q.title).toBe("Remove Grace Wambui?");
    expect(q.body).toContain("Riverside Primary");
    expect(q.body).toContain("can't be undone");
    expect(q.confirmLabel).toBe("Remove administrator");
  });

  it("warns when they are the school's only administrator, and not otherwise", () => {
    expect(removeSchoolAdminQuestion("Grace Wambui", "Riverside Primary", true).body).toMatch(/only administrator/);
    expect(removeSchoolAdminQuestion("Grace Wambui", "Riverside Primary", false).body).not.toMatch(/only administrator/);
  });
});

describe("removeOrgAdminQuestion", () => {
  it("says what they lose and that their login may go too", () => {
    const q = removeOrgAdminQuestion("Peter Otieno", "Kijani Ridge Group");
    expect(q.title).toBe("Remove Peter Otieno?");
    expect(q.body).toContain("Kijani Ridge Group");
    expect(q.body).toMatch(/login is deleted too/);
    expect(q.body).toMatch(/invited again/);
  });
});

describe("orgAdminRemovedNote", () => {
  it("says the login was deleted when it was their only organization", () => {
    expect(orgAdminRemovedNote({ removedAccount: true }, "Peter Otieno", "Kijani Ridge Group")).toBe("Peter Otieno removed, and their login deleted.");
  });

  it("says why the login stayed when they administer another organization", () => {
    const note = orgAdminRemovedNote({ removedAccount: false }, "Peter Otieno", "Kijani Ridge Group");
    expect(note).toContain("removed from Kijani Ridge Group");
    expect(note).toContain("another organization");
  });

  it("passes the function's own warning through, and nothing else, when it has one", () => {
    expect(orgAdminRemovedNote({ removedAccount: false, warning: "kept: records on file" }, "Peter Otieno", "Kijani Ridge Group")).toBe("kept: records on file");
  });
});

describe("schoolAdminTitle", () => {
  it("keeps what was typed, trimmed", () => {
    expect(schoolAdminTitle("  Deputy head ", 3)).toBe("Deputy head");
  });

  it("calls the first administrator the head teacher and later ones administrators", () => {
    expect(schoolAdminTitle("", 0)).toBe("Head teacher");
    expect(schoolAdminTitle("   ", 1)).toBe("Administrator");
  });
});
