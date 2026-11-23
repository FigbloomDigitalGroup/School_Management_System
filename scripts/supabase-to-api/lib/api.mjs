// A small HTTP client for apps/api: bearer session, retries on 429/503 (as the API asks), re-sign-in when the
// idle timeout ends the session, and optional two-step sign-in. It never logs a body: bodies hold real people.
import { totp } from "./totp.mjs";

export class ApiError extends Error {
  constructor(status, code, message, requestId, details) {
    super(`${status} ${code}: ${message}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId ?? null;
    this.details = details ?? null;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi({ baseUrl, fetchImpl = globalThis.fetch, sleep = defaultSleep, now = Date.now } = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  const root = baseUrl.replace(/\/+$/, "");
  let token = null;
  let credentials = null;
  let signingIn = false;

  async function request(method, path, { body, tenantId, idempotencyKey, auth = true } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const headers = { accept: "application/json" };
      // A body-less POST with a JSON content type is rejected by the API's parser, so only set it with a body.
      if (body !== undefined) headers["content-type"] = "application/json";
      if (auth && token) headers.authorization = `Bearer ${token}`;
      if (tenantId) headers["x-tenant-id"] = tenantId;
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

      let res;
      try {
        res = await fetchImpl(`${root}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        if (attempt < 4) {
          await sleep(500 * attempt);
          continue;
        }
        throw new Error(`Could not reach the API for ${method} ${path}: ${e.message}`);
      }

      if ((res.status === 429 || res.status === 503) && attempt <= 6) {
        const wait = Number(res.headers.get("retry-after"));
        await sleep(Math.min(60, Number.isFinite(wait) && wait > 0 ? wait : 1) * 1000);
        continue;
      }

      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (res.ok) return { status: res.status, body: json, headers: res.headers };

      // The idle timeout (15 min) or the 8 h limit ended the session: sign in again once and repeat the call.
      if (res.status === 401 && auth && credentials && !signingIn && path !== "/v1/auth/login/email") {
        await signIn(credentials);
        continue;
      }
      const err = json?.error ?? {};
      throw new ApiError(res.status, err.code ?? "http_error", err.message ?? `HTTP ${res.status}`, err.request_id, err.details);
    }
  }

  async function signIn({ email, password, totpSecret }) {
    credentials = { email, password, totpSecret };
    signingIn = true;
    try {
      const login = await request("POST", "/v1/auth/login/email", { body: { email, password }, auth: false });
      token = login.body.token;
      const status = await request("GET", "/v1/auth/mfa/status");
      const mfa = status.body ?? {};
      if (mfa.required && !mfa.assured) {
        if (mfa.next !== "challenge") {
          throw new Error("This account must set up two-step sign-in in the API before the script can use it.");
        }
        if (!totpSecret) throw new Error("The API asks for a two-step code; set API_TOTP_SECRET (the base32 secret).");
        try {
          await request("POST", "/v1/auth/mfa/challenge", { body: { code: totp(totpSecret, now()) } });
        } catch (e) {
          // A code is accepted once per 30 s window, even across sessions: wait one window and use the next.
          if (!(e instanceof ApiError)) throw e;
          await sleep(31000);
          await request("POST", "/v1/auth/mfa/challenge", { body: { code: totp(totpSecret, now()) } });
        }
      }
      return login.body.user;
    } finally {
      signingIn = false;
    }
  }

  /** Re-confirm the password: provisioning a school and changing its name or time zone need a login within 5 minutes. */
  async function reauth() {
    if (!credentials) throw new Error("Sign in first");
    await request("POST", "/v1/auth/reauth", { body: { password: credentials.password } });
  }

  /** Every page of a keyset-paginated list; `key` is the envelope field that holds the rows. */
  async function listAll(path, key, { tenantId, query = {} } = {}) {
    const rows = [];
    let cursor = null;
    do {
      const qs = new URLSearchParams({ limit: "200", ...query, ...(cursor ? { cursor } : {}) });
      const res = await request("GET", `${path}?${qs}`, { tenantId });
      const page = res.body ?? {};
      rows.push(...(page[key] ?? page.items ?? []));
      cursor = page.page?.next_cursor ?? null;
    } while (cursor);
    return rows;
  }

  return { request, signIn, reauth, listAll, get token() { return token; } };
}
