import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("./supabase", () => ({ supabase: () => ({ functions: { invoke } }) }));

import { resolveLoginId, searchSchools } from "./auth";

/** What supabase-js returns for a non-2xx answer: the Response rides along on error.context. */
const httpError = (status: number, body: unknown) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify(body), { status }) },
});

// braces matter: a function returned from beforeEach is run as cleanup, and mockReset() returns the mock
beforeEach(() => { invoke.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("searchSchools", () => {
  it("returns the schools the function found", async () => {
    invoke.mockResolvedValue({ data: { schools: [{ id: "t1", name: "Alliance High School", slug: "alliance", county: "Kiambu" }] }, error: null });
    await expect(searchSchools("alli")).resolves.toEqual([{ id: "t1", name: "Alliance High School", slug: "alliance", county: "Kiambu" }]);
    expect(invoke).toHaveBeenCalledWith("search-schools", expect.objectContaining({ body: { query: "alli" } }));
  });

  it("rejects with the function's own sentence when it answers an error", async () => {
    invoke.mockResolvedValue(httpError(500, { error: "Could not look that up." }));
    await expect(searchSchools("alli")).rejects.toThrow("Could not look that up.");
  });

  it("rejects when the service isn't there at all (a bare gateway 503)", async () => {
    invoke.mockResolvedValue(httpError(503, { message: "name resolution failed" }));
    await expect(searchSchools("alli")).rejects.toThrow("Edge Function returned a non-2xx status code");
  });

  it("gives up after 8 seconds instead of waiting forever", async () => {
    vi.useFakeTimers();
    // a request that only ends when it is aborted, the way a fetch on a dead connection does
    invoke.mockImplementation((_fn: string, opts: { signal: AbortSignal }) =>
      new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve({ data: null, error: { message: "aborted" } }))));
    const result = searchSchools("alli");
    const assertion = expect(result).rejects.toThrow("That took too long. Check your connection and try again.");
    await vi.advanceTimersByTimeAsync(7999);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });

  it("does not time out an answer that arrives in time", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ data: { schools: [] }, error: null }), 3000)));
    const result = searchSchools("alli");
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toEqual([]);
  });
});

describe("resolveLoginId", () => {
  it("returns the masked name and sign-in email", async () => {
    invoke.mockResolvedValue({ data: { ok: true, display_name: "Esther H.", email: "pt-0002@login.alliance.figbloom.internal" }, error: null });
    const r = await resolveLoginId("t1", "PT-0002");
    expect(r.display_name).toBe("Esther H.");
    expect(invoke).toHaveBeenCalledWith("resolve-login-id", expect.objectContaining({ body: { tenant_id: "t1", login_id: "PT-0002" } }));
  });

  it("shows the rate limit's sentence to the person, not a generic failure", async () => {
    invoke.mockResolvedValue(httpError(429, { error: "Too many attempts. Wait a few minutes and try again." }));
    await expect(resolveLoginId("t1", "PT-0002")).rejects.toThrow("Too many attempts. Wait a few minutes and try again.");
  });

  it("shows the 'couldn't find that ID' sentence for an unknown ID", async () => {
    invoke.mockResolvedValue(httpError(404, { error: "We couldn't find that ID at this school. Check with the school office." }));
    await expect(resolveLoginId("t1", "PT-9999")).rejects.toThrow("We couldn't find that ID at this school.");
  });

  it("gives up after 8 seconds too", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation((_fn: string, opts: { signal: AbortSignal }) =>
      new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve({ data: null, error: { message: "aborted" } }))));
    const assertion = expect(resolveLoginId("t1", "PT-0002")).rejects.toThrow("That took too long.");
    await vi.advanceTimersByTimeAsync(8001);
    await assertion;
  });
});
