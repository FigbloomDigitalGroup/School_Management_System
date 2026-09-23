import { describe, expect, it } from "vitest";
import { gradingSchemeFor } from "./gradingSchemes";

describe("gradingSchemeFor", () => {
  it("Kenya: primary and junior_secondary get cbc, secondary gets kcse", () => {
    expect(gradingSchemeFor("KE", "primary")).toBe("cbc");
    expect(gradingSchemeFor("KE", "junior_secondary")).toBe("cbc");
    expect(gradingSchemeFor("KE", "secondary")).toBe("kcse");
  });

  it("falls back to kcse for an unregistered country rather than throwing", () => {
    expect(gradingSchemeFor("XX", "primary")).toBe("kcse");
    expect(gradingSchemeFor("XX", "secondary")).toBe("kcse");
  });
});
