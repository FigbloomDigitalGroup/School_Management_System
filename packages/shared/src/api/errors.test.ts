import { describe, expect, it } from "vitest";
import { ApiError, apiErrorFromResponse, fieldErrors, isRetryableApiError, userMessage } from "./errors";

const headers = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("apiErrorFromResponse", () => {
  it("reads the API's error shape", () => {
    const e = apiErrorFromResponse(409, { error: { code: "conflict", message: "Taken", request_id: "r1" } }, headers());
    expect(e).toMatchObject({ status: 409, code: "conflict", message: "Taken", requestId: "r1" });
  });

  it("takes the request id from the header when the body has none", () => {
    const e = apiErrorFromResponse(500, { error: { code: "internal_error", message: "x" } }, headers({ "x-request-id": "hdr-1" }));
    expect(e.requestId).toBe("hdr-1");
  });

  it("falls back to the status when the body gives no known code", () => {
    expect(apiErrorFromResponse(401, undefined, headers()).code).toBe("unauthorized");
    expect(apiErrorFromResponse(403, { error: { code: "weird", message: "x" } }, headers()).code).toBe("forbidden");
    expect(apiErrorFromResponse(404, "nope", headers()).code).toBe("not_found");
    expect(apiErrorFromResponse(422, undefined, headers()).code).toBe("idempotency_key_reused");
    expect(apiErrorFromResponse(503, undefined, headers()).code).toBe("service_unavailable");
    expect(apiErrorFromResponse(418, undefined, headers()).code).toBe("validation_error");
    expect(apiErrorFromResponse(502, undefined, headers()).code).toBe("internal_error");
  });

  it("knows the HR & Payroll hand-off's codes instead of folding them into the status's (a 403 handoff_off is not a plain forbidden)", () => {
    const kept: [number, string][] = [
      [403, "handoff_off"], [409, "already_connected"], [409, "target_not_enabled"], [409, "target_not_linked"], [409, "target_no_handoff_url"],
      [409, "school_not_linked"], [503, "hr_unavailable"], [502, "hr_bad_answer"], [429, "rate_limited"],
    ];
    for (const [status, code] of kept) expect(apiErrorFromResponse(status, { error: { code, message: "m" } }, headers()).code).toBe(code);
  });

  it("keeps only well-formed details", () => {
    const e = apiErrorFromResponse(400, { error: { code: "validation_error", message: "m", details: [{ field: "a", code: "c", message: "ma" }, { nope: 1 }, "x"] } }, headers());
    expect(e.details).toEqual([{ field: "a", code: "c", message: "ma" }]);
  });

  it("ignores a Retry-After that is not whole seconds", () => {
    expect(apiErrorFromResponse(429, undefined, headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).retryAfterSeconds).toBeNull();
  });
});

describe("userMessage", () => {
  const err = (code: ApiError["code"], extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
    new ApiError({ status: 400, code, message: "server words", ...extra });

  it("uses the server's words for validation, conflict and not found", () => {
    expect(userMessage(err("validation_error"))).toBe("server words");
    expect(userMessage(err("conflict"))).toBe("server words");
    expect(userMessage(err("not_found"))).toBe("server words");
  });
  it("writes its own for network, timeout, throttling, outage and server faults", () => {
    expect(userMessage(err("network_error"))).toMatch(/can't reach/i);
    expect(userMessage(err("timeout"))).toMatch(/too long/i);
    expect(userMessage(err("rate_limited", { retryAfterSeconds: 1 }))).toBe("Too many attempts. Try again in 1 second.");
    expect(userMessage(err("rate_limited", { retryAfterSeconds: 30 }))).toBe("Too many attempts. Try again in 30 seconds.");
    expect(userMessage(err("rate_limited"))).toMatch(/wait a moment/i);
    expect(userMessage(err("service_unavailable"))).toMatch(/busy/i);
    expect(userMessage(err("internal_error", { requestId: "abc123xyz" }))).toContain("abc123xyz");
  });
  it("never shows a server fault's own text", () => {
    expect(userMessage(err("internal_error"))).not.toContain("server words");
  });
  it("shows a forbidden message that says something, and a plain one otherwise", () => {
    expect(userMessage(err("forbidden"))).toBe("server words");
    expect(userMessage(new ApiError({ status: 403, code: "forbidden", message: "The server answered 403." }))).toBe("You don't have permission to do that.");
  });
  it("passes a plain Error's message through, and has a fallback", () => {
    expect(userMessage(new Error("boom"))).toBe("boom");
    expect(userMessage("what")).toBe("Something went wrong.");
  });
});

describe("fieldErrors and isRetryableApiError", () => {
  it("maps details to field -> first message", () => {
    const e = new ApiError({ status: 400, code: "validation_error", message: "m", details: [
      { field: "email", code: "a", message: "first" }, { field: "email", code: "b", message: "second" }, { field: "name", code: "c", message: "n" },
    ] });
    expect(fieldErrors(e)).toEqual({ email: "first", name: "n" });
    expect(fieldErrors(new Error("x"))).toEqual({});
  });
  it("calls an outage or a lost connection retryable, and nothing else", () => {
    const r = (code: ApiError["code"]) => isRetryableApiError(new ApiError({ status: 0, code, message: "" }));
    expect([r("service_unavailable"), r("network_error"), r("timeout")]).toEqual([true, true, true]);
    expect([r("unauthorized"), r("validation_error"), r("internal_error"), r("rate_limited")]).toEqual([false, false, false, false]);
    expect(isRetryableApiError(new Error("x"))).toBe(false);
  });
});
