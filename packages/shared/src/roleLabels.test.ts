import { describe, expect, it } from "vitest";
import { isHigherEd, roleLabel } from "./roleLabels";

describe("roleLabel", () => {
  it("defaults to K-12 labels for a k12 tenant with no overrides", () => {
    const tenant = { institution_type: "k12" as const, role_labels: {} };
    expect(roleLabel(tenant, "teacher")).toBe("Teacher");
    expect(roleLabel(tenant, "parent")).toBe("Parent");
  });

  it("defaults to higher-ed labels for a higher_ed tenant with no overrides", () => {
    const tenant = { institution_type: "higher_ed" as const, role_labels: {} };
    expect(roleLabel(tenant, "teacher")).toBe("Lecturer");
    expect(roleLabel(tenant, "parent")).toBe("Guardian");
  });

  it("a tenant override wins over the institution-type default", () => {
    const tenant = { institution_type: "higher_ed" as const, role_labels: { teacher: "Professor" } };
    expect(roleLabel(tenant, "teacher")).toBe("Professor");
    // untouched keys still fall back to the type default
    expect(roleLabel(tenant, "student")).toBe("Student");
  });
});

describe("isHigherEd", () => {
  it("is true only for a higher_ed tenant", () => {
    expect(isHigherEd({ institution_type: "higher_ed" })).toBe(true);
    expect(isHigherEd({ institution_type: "k12" })).toBe(false);
  });
});
