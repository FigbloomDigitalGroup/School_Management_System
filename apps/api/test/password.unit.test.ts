import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/modules/identity/password.js";
import { RETIRED_ROLES, isSchoolRole, mayHoldAdminAreas } from "../src/modules/identity/roles.js";

describe("password + role inventory units", () => {
  it("hashes and verifies with timing-safe compare", async () => {
    const hash = await hashPassword("figbloom-dev");
    expect(await verifyPassword("figbloom-dev", hash)).toBe(true);
    expect(await verifyPassword("figbloom-devv", hash)).toBe(false);
    expect(await verifyPassword("figbloom-dev", "not-a-hash")).toBe(false);
  });

  it("keeps legacy school roles and refuses retired gate roles", () => {
    expect(isSchoolRole("teacher")).toBe(true);
    expect(isSchoolRole("staff")).toBe(true);
    expect(isSchoolRole("guard")).toBe(false);
    expect(RETIRED_ROLES).toContain("receptionist");
    expect(mayHoldAdminAreas("teacher")).toBe(true);
    expect(mayHoldAdminAreas("parent")).toBe(false);
  });
});
