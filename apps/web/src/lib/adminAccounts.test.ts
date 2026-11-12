import { describe, expect, it } from "vitest";
import { removeSchoolAdminQuestion, schoolAdminTitle } from "./adminAccounts";

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

describe("schoolAdminTitle", () => {
  it("keeps what was typed, trimmed", () => {
    expect(schoolAdminTitle("  Deputy head ", 3)).toBe("Deputy head");
  });

  it("calls the first administrator the head teacher and later ones administrators", () => {
    expect(schoolAdminTitle("", 0)).toBe("Head teacher");
    expect(schoolAdminTitle("   ", 1)).toBe("Administrator");
  });
});
