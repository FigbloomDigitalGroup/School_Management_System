import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "./api.mjs";
import { totp } from "./totp.mjs";

// RFC 6238 appendix B: the secret is the ASCII string "12345678901234567890". The RFC lists 8-digit codes, and the API uses 6.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(totp(RFC_SECRET, 59_000)).toBe("287082");
    expect(totp(RFC_SECRET, 1_111_111_109_000)).toBe("081804");
    expect(totp(RFC_SECRET, 1_234_567_890_000)).toBe("005924");
  });

  it("gives the next window's code with a step offset", () => {
    expect(totp(RFC_SECRET, 29_000, 1)).toBe(totp(RFC_SECRET, 31_000));
  });

  it("refuses a secret that is not base32", () => {
    expect(() => totp("not*base32", 0)).toThrow(/base32/);
  });
});

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call = { method: init.method, url, headers: init.headers, body: init.body };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("the API client", () => {
  it("sends the bearer, the school header and the idempotency key, and no content type without a body", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/login/email") ? json(200, { token: "tok", user: {} }) : c.url.endsWith("/mfa/status") ? json(200, { required: false }) : json(200, {})));
    const api = createApi({ baseUrl: "http://x/", fetchImpl: f.fn, sleep: async () => {} });
    await api.signIn({ email: "a@b.co", password: "pw" });
    await api.request("POST", "/v1/tenants/t/learners/1/archive", { tenantId: "t" });
    await api.request("POST", "/v1/tenants/t/learners", { tenantId: "t", body: { a: 1 }, idempotencyKey: "mig:learner:1" });
    const [archive, create] = f.calls.slice(-2);
    expect(archive.headers.authorization).toBe("Bearer tok");
    expect(archive.headers["x-tenant-id"]).toBe("t");
    expect(archive.headers["content-type"]).toBeUndefined();
    expect(create.headers["content-type"]).toBe("application/json");
    expect(create.headers["idempotency-key"]).toBe("mig:learner:1");
    expect(f.calls[0].url).toBe("http://x/v1/auth/login/email");
  });

  it("waits as Retry-After asks on 429 and 503, then succeeds", async () => {
    const waits: number[] = [];
    const f = fakeFetch((_c, n) => (n === 1 ? json(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "3" }) : n === 2 ? json(503, {}, { "retry-after": "1" }) : json(200, { ok: true })));
    const api = createApi({ baseUrl: "http://x", fetchImpl: f.fn, sleep: async (ms: number) => void waits.push(ms) });
    const res = await api.request("GET", "/v1/anything", { auth: false });
    expect(res.body).toEqual({ ok: true });
    expect(waits).toEqual([3000, 1000]);
  });

  it("signs in again once when the session has timed out, then repeats the call", async () => {
    let logins = 0;
    let first = true;
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/login/email")) return json(200, { token: `tok${(logins += 1)}`, user: {} });
      if (c.url.endsWith("/mfa/status")) return json(200, { required: false });
      if (first) {
        first = false;
        return json(401, { error: { code: "unauthorized", message: "expired" } });
      }
      return json(200, { done: true });
    });
    const api = createApi({ baseUrl: "http://x", fetchImpl: f.fn, sleep: async () => {} });
    await api.signIn({ email: "a@b.co", password: "pw" });
    const res = await api.request("GET", "/v1/thing");
    expect(res.body).toEqual({ done: true });
    expect(logins).toBe(2);
    expect(f.calls.at(-1)?.headers.authorization).toBe("Bearer tok2");
  });

  it("raises an ApiError with the code and request id", async () => {
    const f = fakeFetch(() => json(409, { error: { code: "conflict", message: "Admission X is already on the roster", request_id: "req-1" } }));
    const api = createApi({ baseUrl: "http://x", fetchImpl: f.fn, sleep: async () => {} });
    await expect(api.request("POST", "/v1/x", { auth: false, body: {} })).rejects.toMatchObject({ status: 409, code: "conflict", requestId: "req-1" });
    await expect(api.request("POST", "/v1/x", { auth: false, body: {} })).rejects.toBeInstanceOf(ApiError);
  });

  it("answers the two-step challenge with a code from the secret", async () => {
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/login/email")) return json(200, { token: "t", user: {} });
      if (c.url.endsWith("/mfa/status")) return json(200, { required: true, assured: false, next: "challenge" });
      return json(200, { verified: true });
    });
    const api = createApi({ baseUrl: "http://x", fetchImpl: f.fn, sleep: async () => {}, now: () => 59_000 });
    await api.signIn({ email: "a@b.co", password: "pw", totpSecret: RFC_SECRET });
    const challenge = f.calls.find((c) => c.url.endsWith("/mfa/challenge"))!;
    expect(JSON.parse(challenge.body!)).toEqual({ code: "287082" });
  });

  it("explains itself when the account has not set up two-step sign-in", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/login/email") ? json(200, { token: "t", user: {} }) : json(200, { required: true, assured: false, next: "enroll" })));
    const api = createApi({ baseUrl: "http://x", fetchImpl: f.fn, sleep: async () => {} });
    await expect(api.signIn({ email: "a@b.co", password: "pw" })).rejects.toThrow(/set up two-step/);
  });

  it("follows the cursor through every page", async () => {
    const f = fakeFetch((c) => {
      const cursor = new URL(c.url).searchParams.get("cursor");
      return cursor ? json(200, { learners: [{ id: 3 }], page: { next_cursor: null } }) : json(200, { learners: [{ id: 1 }, { id: 2 }], page: { next_cursor: "c2" } });
    });
    const api = createApi({ baseUrl: "http://x", fetchImpl: f.fn, sleep: async () => {} });
    const rows = await api.listAll("/v1/tenants/t/learners", "learners", { tenantId: "t" });
    expect(rows.map((r: any) => r.id)).toEqual([1, 2, 3]);
  });
});
