import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, signInAs, TEST_ROLES, type SignedIn, type TestRole } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 08 (FIG-1241): is access controlled by the SERVER, not by the screens redirecting you?
 *
 * Real HTTP against the local stack: the REST API, the edge functions its runtime serves, and Auth. Three parts:
 *   1. The REST API and the functions with no token, a garbage token, an expired token, and the project's public anon key.
 *   2. Sessions: two at once, and what signing out really does.
 *   3. The first-sign-in rule (must_change_password) and the password rules, as the server (not the form) enforces them.
 *
 * "Expired" needs a correctly signed token, so it is minted with the local stack's JWT secret, which is the public default every
 * local Supabase project ships with. A control first proves the minting works (a minted token that has NOT expired is accepted);
 * if a developer's stack uses another secret the expiry tests are skipped, and the output says so.
 *
 * Not covered here, on purpose: rider-update, call-token and chat-push (the local runtime was started before they existed, so it
 * answers 404 for them: their Deno handler tests cover the caller checks), and the functions that differ on main (invite-admin,
 * provision-*, delete-account, reset-user-password and others), which QA 03 and the Deno tests cover.
 *
 * The first-sign-in tests briefly arm must_change_password on the seeded driver (BD-0001) and try a weak password on it; both are
 * put back in afterAll, and afterAll fails loudly if the driver can no longer sign in with the seed password.
 * The known defects use it.fails: they pass while the defect exists and fail when it is fixed. Then change it.fails to it.
 */

const base = () => assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin;
const anonKey = () => process.env.VITE_SUPABASE_ANON_KEY!;
const SEED_PASSWORD = "figbloom-dev";

// ---------------------------------------------------------------- tokens
/** The default JWT secret of a local Supabase project (public, in Supabase's own docs). */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(claims: Record<string, unknown>): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(claims);
  return `${head}.${body}.${createHmac("sha256", LOCAL_JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
const now = () => Math.floor(Date.now() / 1000);

async function sessionOf(c: SupabaseClient) {
  const { data } = await c.auth.getSession();
  return data.session!;
}

async function rest(path: string, token: string | null, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base()}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: { apikey: anonKey(), "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, text: await res.text() };
}

async function fn(name: string, token: string | null) {
  const res = await fetch(`${base()}/functions/v1/${name}`, {
    method: "POST",
    headers: { apikey: anonKey(), "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: "{}",
  });
  return { status: res.status, text: await res.text() };
}

// One real parent token to copy the identity from when minting.
const parent = await signInAs("parent");
const parentToken = (await sessionOf(parent.client)).access_token;
const parentClaims = claimsOf(parentToken);
const validMinted = mint({ ...parentClaims, iat: now(), exp: now() + 600 });
const expiredMinted = mint({ ...parentClaims, iat: now() - 7200, exp: now() - 3600 });
// signed and unexpired, but its session_id names no session in Auth (the parent's own session_id would still be alive)
const orphanMinted = mint({ ...parentClaims, session_id: "00000000-0000-4000-8000-000000000000", iat: now(), exp: now() + 600 });
const tamperedToken = (() => { const [h, , s] = parentToken.split("."); return `${h}.${b64({ ...parentClaims, role: "service_role" })}.${s}`; })();
const secretWorks = (await rest("students?select=id&limit=1", validMinted)).status === 200;

const BAD_TOKENS: [string, string][] = [["a garbage token", "not.a.jwt"], ["a tampered token (role changed to service_role)", tamperedToken]];

// ---------------------------------------------------------------- 1. REST
describe("REST API: no token, a bad token, an expired token", () => {
  const reads = ["students", "profiles", "fee_invoices", "payments", "audit_events"];
  const rpcs: [string, unknown][] = [
    ["record_payment", { p_invoice_id: "00000000-0000-0000-0000-000000000000", p_amount_cents: 100, p_method: "cash", p_reference: null }],
    ["log_admin_event", { p_tenant_id: "00000000-0000-0000-0000-000000000000", p_event: "x", p_category: "financial", p_metadata: {} }],
    ["archive_learners", { p_ids: ["00000000-0000-0000-0000-000000000000"] }],
  ];

  it.each(reads)("no token: %s answers an empty list, not data", async (table) => {
    const res = await rest(`${table}?select=id&limit=1`, null);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual([]);
  });

  it.each(rpcs)("no token: the %s function is refused", async (name, body) => {
    expect((await rest(`rpc/${name}`, null, { method: "POST", body })).status).toBe(401);
  });

  it.each(BAD_TOKENS)("%s is refused on every table and function", async (_label, token) => {
    for (const table of reads) expect((await rest(`${table}?select=id&limit=1`, token)).status, table).toBe(401);
    for (const [name, body] of rpcs) expect((await rest(`rpc/${name}`, token, { method: "POST", body })).status, name).toBe(401);
  });

  it.skipIf(!secretWorks)("control: a correctly signed token that has NOT expired is accepted (so the expiry test below is about expiry)", async () => {
    const res = await rest("students?select=id&limit=1", validMinted);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).length).toBeGreaterThan(0);
  });

  it.skipIf(!secretWorks)("an expired token is refused on every table and function, saying it expired", async () => {
    for (const table of reads) {
      const res = await rest(`${table}?select=id&limit=1`, expiredMinted);
      expect(res.status, table).toBe(401);
      expect(res.text).toContain("JWT expired");
    }
    for (const [name, body] of rpcs) expect((await rest(`rpc/${name}`, expiredMinted, { method: "POST", body })).status, name).toBe(401);
  });

  it.each(["parent", "student", "teacher", "driver"] as TestRole[])("a %s token is refused on the money functions (wrong role)", async (role) => {
    const who = await signInAs(role);
    const token = (await sessionOf(who.client)).access_token;
    for (const [name, body] of rpcs.slice(0, 2)) expect((await rest(`rpc/${name}`, token, { method: "POST", body })).status, name).toBe(403);
  });
});

// ---------------------------------------------------------------- 1b. edge functions the local runtime serves
describe("edge functions (the ones this runtime serves, unchanged on main): no token, a bad token, an expired token, the anon key", () => {
  const served = ["bus-tick", "create-organization", "check-services"];

  it.each(served)("%s refuses a request with no token, a garbage token and the project's anon key", async (name) => {
    for (const token of [null, "not.a.jwt", anonKey(), tamperedToken]) {
      const res = await fn(name, token);
      expect(res.status, `${name} with ${token === null ? "no token" : token.slice(0, 12)}`).toBe(401);
    }
  });

  it.skipIf(!secretWorks).each(served)("%s refuses an expired token at the gateway", async (name) => {
    const res = await fn(name, expiredMinted);
    expect(res.status).toBe(401);
  });

  it.skipIf(!secretWorks).each(served)("%s refuses a validly signed, unexpired token whose session no longer exists", async (name) => {
    // the gateway only checks signature and expiry; the function's own getUser() asks Auth, which has no such session
    expect((await fn(name, orphanMinted)).status).toBe(401);
  });

  it.each(["school_admin", "teacher", "parent", "student", "driver", "platform_staff"] as TestRole[])("create-organization refuses a %s (only an organization admin may create one)", async (role) => {
    const who = await signInAs(role);
    const res = await fn("create-organization", (await sessionOf(who.client)).access_token);
    expect(res.status).toBe(403);
  });

  it.each(["school_admin", "org_admin", "teacher", "parent", "student", "driver"] as TestRole[])("check-services refuses a %s (only Figbloom staff may run it)", async (role) => {
    const who = await signInAs(role);
    const res = await fn("check-services", (await sessionOf(who.client)).access_token);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------- 2. sessions
describe("sessions", () => {
  const login = async () => {
    const c = anonClient();
    const { data, error } = await c.auth.signInWithPassword({ email: TEST_ROLES.parent.email, password: TEST_ROLES.parent.password });
    if (error) throw new Error(error.message);
    return { client: c, session: data.session! };
  };
  const user = async (token: string) => {
    const res = await fetch(`${base()}/auth/v1/user`, { headers: { apikey: anonKey(), Authorization: `Bearer ${token}` } });
    return res.status;
  };
  const refresh = async (refreshToken: string) => {
    const res = await fetch(`${base()}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { apikey: anonKey(), "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return res.status;
  };

  it("two sessions of one account work at the same time, with different session ids", async () => {
    const a = await login();
    const b = await login();
    expect(claimsOf(a.session.access_token).session_id).not.toBe(claimsOf(b.session.access_token).session_id);
    expect((await rest("students?select=id&limit=1", a.session.access_token)).status).toBe(200);
    expect((await rest("students?select=id&limit=1", b.session.access_token)).status).toBe(200);
    await a.client.auth.signOut({ scope: "local" });
    await b.client.auth.signOut({ scope: "local" });
  });

  it("a renewed session gets new tokens; and after sign-out the refresh token is dead and Auth refuses the old access token", async () => {
    const a = await login();
    const renewed = await a.client.auth.refreshSession();
    expect(renewed.error).toBeNull();
    expect(renewed.data.session!.access_token).not.toBe(a.session.access_token);
    const current = renewed.data.session!;
    await a.client.auth.signOut({ scope: "local" });
    expect(await refresh(current.refresh_token)).toBe(400);
    expect(await user(current.access_token)).toBe(403); // session_not_found: the edge functions call getUser(), so they refuse it too
  });

  it("signing out with scope 'local' leaves the account's other session working (control)", async () => {
    const a = await login();
    const b = await login();
    await a.client.auth.signOut({ scope: "local" });
    expect(await user(b.session.access_token)).toBe(200);
    expect(await refresh(b.session.refresh_token)).toBe(200);
    await b.client.auth.signOut({ scope: "local" });
  });

  // The access token is a signed JWT that PostgREST checks only for signature and expiry (an hour here). Auth knows the session is
  // gone (the test above), the REST API does not ask it.
  it.fails("FIG-1339 (open): after sign-out the old access token no longer reads data through the REST API", async () => {
    const a = await login();
    const token = a.session.access_token;
    await a.client.auth.signOut({ scope: "local" });
    expect((await rest("students?select=id&limit=1", token)).status).toBe(401);
  });

  // supabase-js signOut() defaults to scope 'global': the web Sign out button, the "Not you? Sign out" link and the wrong-portal
  // check all call it without a scope, so ending one session ends every session of the account, on every device.
  it.fails("FIG-1340 (open): signing out one session (the way the apps do it) leaves the account's other session working", async () => {
    const a = await login();
    const b = await login();
    await a.client.auth.signOut(); // exactly what the apps call
    expect(await user(b.session.access_token)).toBe(200);
  });
});

// ---------------------------------------------------------------- 3. first sign-in and password rules
describe("first sign-in: what the server enforces (the screens ask for a new password; do they have to?)", () => {
  let admin: SignedIn;
  let driver: SignedIn;
  let driverId = "";

  beforeAll(async () => {
    admin = await signInAs("school_admin");
    const p = await admin.client.from("profiles").select("id").eq("login_id", "BD-0001").single();
    driverId = p.data!.id as string;
    const armed = await admin.client.from("profiles").update({ must_change_password: true }).eq("id", driverId).select("must_change_password");
    expect(armed.data?.[0]?.must_change_password, "the school admin can hand out a temporary password (arm the flag)").toBe(true);
    driver = await signInAs("driver");
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.client.from("profiles").update({ must_change_password: false }).eq("id", driverId);
    // the weak-password test changes this account's password and changes it back: make sure it is back
    const check = anonClient();
    const { error } = await check.auth.signInWithPassword({ email: TEST_ROLES.driver.email, password: SEED_PASSWORD });
    if (error) throw new Error(`The seeded driver (BD-0001) can no longer sign in with ${SEED_PASSWORD}: ${error.message}. Reseed or reset that account.`);
    await check.auth.signOut({ scope: "local" });
  }, 60_000);

  it("the flag is set on the driver's profile and the driver signs in with the temporary password (control)", async () => {
    const me = await driver.client.from("profiles").select("must_change_password").eq("id", driverId).single();
    expect(me.data!.must_change_password).toBe(true);
  });

  // The web and phone screens show only the choose-a-password form while the flag is set. The server does not: every request works.
  it.fails("FIG-1338 (open): while must_change_password is set the server refuses everything except choosing a password", async () => {
    const res = await driver.client.from("vehicles").select("id").limit(1);
    expect(res.error, "reading with a temporary password").not.toBeNull();
  });

  // The form clears the flag itself, with a plain profile update after changing the password. Nothing makes the two go together.
  it.fails("FIG-1338 (open): the flag cannot be cleared without choosing a new password", async () => {
    const res = await driver.client.from("profiles").update({ must_change_password: false }).eq("id", driverId).select("must_change_password");
    expect(res.error, "clearing the flag by hand").not.toBeNull();
  });

  it("the flag can never be re-armed by the account itself (only the office can)", async () => {
    // start from "cleared" whatever the tests above did, then the account tries to switch it back on
    await admin.client.from("profiles").update({ must_change_password: false }).eq("id", driverId);
    const res = await driver.client.from("profiles").update({ must_change_password: true }).eq("id", driverId).select("must_change_password");
    expect(res.error?.code).toBe("42501");
  });

  // The form asks for 8 characters; Auth accepts 6 (its default, nothing in supabase/config.toml raises it).
  it.fails("FIG-1338 (open): the server enforces the 8-character minimum the form asks for", async () => {
    let failure: unknown;
    try {
      const weak = await driver.client.auth.updateUser({ password: "abc123" });
      expect(weak.error, "a 6-character password").not.toBeNull();
    } catch (e) {
      failure = e;
    }
    // put the seeded password back whatever happened above (a throw inside `finally` would hide the failure)
    const back = await driver.client.auth.updateUser({ password: SEED_PASSWORD });
    if (back.error) throw new Error(`could not restore the seed password: ${back.error.message}`);
    if (failure) throw failure;
  });
});
