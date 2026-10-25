import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("./supabase", () => ({ supabase: () => ({ functions: { invoke } }) }));

import { passwordResetRequestedMessage, recoveryLinkProblem, requestPasswordReset, resetUserPassword, roleFromLoginId } from "./passwordReset";

beforeEach(() => { invoke.mockReset(); });

describe("requestPasswordReset", () => {
  it("sends the school and the ID as typed (trimmed)", async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    await requestPasswordReset("t1", "  st-0001 ");
    expect(invoke).toHaveBeenCalledWith("request-password-reset", expect.objectContaining({ body: { tenant_id: "t1", login_id: "st-0001" } }));
  });

  it("passes on the function's own sentence when it refuses", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: { message: "non-2xx", context: new Response(JSON.stringify({ error: "Too many attempts." }), { status: 429 }) },
    });
    await expect(requestPasswordReset("t1", "ST-0001")).rejects.toThrow("Too many attempts.");
  });
});

describe("resetUserPassword", () => {
  it("returns the one-time password", async () => {
    invoke.mockResolvedValue({ data: { ok: true, password: "abcDEF2345", login_id: "ST-0001", full_name: "Esther" }, error: null });
    await expect(resetUserPassword("p1")).resolves.toMatchObject({ password: "abcDEF2345", login_id: "ST-0001" });
    expect(invoke).toHaveBeenCalledWith("reset-user-password", expect.objectContaining({ body: { profile_id: "p1" } }));
  });
});

describe("passwordResetRequestedMessage", () => {
  it("never claims the ID exists", () => {
    for (const role of ["student", "parent", "teacher", "driver", null] as const) {
      expect(passwordResetRequestedMessage(role)).toMatch(/^If that ID is right/);
    }
  });

  it("points a learner at their parent too", () => {
    expect(passwordResetRequestedMessage("student")).toMatch(/parent/);
    expect(passwordResetRequestedMessage("teacher")).not.toMatch(/parent/);
  });
});

describe("recoveryLinkProblem", () => {
  it("is null for a normal recovery link", () => {
    expect(recoveryLinkProblem("#access_token=x&type=recovery", "")).toBeNull();
    expect(recoveryLinkProblem("", "")).toBeNull();
  });

  it("explains an expired or used link from the hash", () => {
    expect(recoveryLinkProblem("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid", "")).toMatch(/expired/);
  });

  it("reads the error from the query too", () => {
    expect(recoveryLinkProblem("", "?error=server_error&error_code=unexpected")).toMatch(/didn't work/);
  });
});

describe("roleFromLoginId", () => {
  it("reads the role from the prefix, whatever the case", () => {
    expect(roleFromLoginId("st-0001")).toBe("student");
    expect(roleFromLoginId(" PT-0029 ")).toBe("parent");
    expect(roleFromLoginId("TC-0001")).toBe("teacher");
  });

  it("is null for anything else", () => {
    expect(roleFromLoginId("XX-0001")).toBeNull();
    expect(roleFromLoginId("")).toBeNull();
  });
});
