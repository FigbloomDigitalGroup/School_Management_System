import { beforeAll, describe, expect, it } from "vitest";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 08 (FIG-1241): the three functions anyone can call without an account (search-schools, resolve-login-id, signup-organization),
 * as the local runtime serves them. All three are unchanged on main, so what holds here holds there.
 *
 * What is checked: the masked name, that an unknown ID and an unknown school answer identically, the per-caller limits, and that
 * odd input never brings the database's own words back. What is NOT done here: creating an organization (nothing here can clean
 * one up; signup-organization's happy path is in supabase/functions/signup-organization).
 *
 * The limits are counted per "caller", which the function reads from the request's cf-connecting-ip or x-forwarded-for header.
 * Every test uses its own made-up caller value, so no real caller's allowance (and no developer's sign-in) is touched. The rows
 * this leaves in login_lookups are cleared by e2e/flows.spec.ts's beforeAll.
 * The known defect uses it.fails: it passes while the defect exists and fails when it is fixed. Then change it.fails to it.
 */

const base = () => assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin;
const anonKey = () => process.env.VITE_SUPABASE_ANON_KEY!;
const run = Date.now().toString(36);

async function post(name: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base()}/functions/v1/${name}`, {
    method: "POST",
    headers: { apikey: anonKey(), "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

const caller = (label: string) => ({ "x-forwarded-for": `qa8-${run}-${label}` });

let school = { id: "", name: "" };
beforeAll(async () => {
  const res = await post("search-schools", { query: "Alliance" }, caller("setup"));
  school = (res.json.schools as { id: string; name: string }[])[0]!;
  expect(school?.id, "the first demo school is findable").toBeTruthy();
});

describe("search-schools", () => {
  it("finds a school by part of its name, at most 8, with no private fields", async () => {
    const res = await post("search-schools", { query: "high" }, caller("search"));
    expect(res.status).toBe(200);
    const schools = res.json.schools as Record<string, unknown>[];
    expect(schools.length).toBeLessThanOrEqual(8);
    for (const s of schools) expect(Object.keys(s).sort()).toEqual(["county", "id", "name", "slug"]);
  });

  it("answers an empty list to a query shorter than two characters, and to wildcard characters alone", async () => {
    expect((await post("search-schools", { query: "a" }, caller("short"))).json.schools).toEqual([]);
    expect((await post("search-schools", { query: "%_" }, caller("wild"))).json.schools).toEqual([]);
  });

  it("never brings the database's own words back, whatever it is sent", async () => {
    for (const query of ["'; drop table tenants;--", "\\", "x".repeat(20_000), "\u0000", "💥".repeat(50)]) {
      const res = await post("search-schools", { query }, caller("odd"));
      expect(res.text, `query of ${query.length} characters`).not.toMatch(/relation|column|violates|syntax|postgres|pg_|constraint|function public/i);
    }
  });
});

describe("resolve-login-id", () => {
  it("answers with a masked name (first name and the last name's initial) and the sign-in address, nothing else", async () => {
    const res = await post("resolve-login-id", { tenant_id: school.id, login_id: "tc-0002" }, caller("mask"));
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(["display_name", "email", "ok"]);
    expect(res.json.display_name).toMatch(/^\p{Lu}[\p{L}'-]+ \p{Lu}\.$/u);
    expect(res.json.email).toBe("tc-0002@login.alliance.figbloom.internal");
  });

  it("answers an ID that does not exist, and a school that does not exist, with the same 404 and the same words", async () => {
    const noId = await post("resolve-login-id", { tenant_id: school.id, login_id: "TC-9999" }, caller("noid"));
    const noSchool = await post("resolve-login-id", { tenant_id: "00000000-0000-0000-0000-000000000000", login_id: "TC-0002" }, caller("noschool"));
    const notAUuid = await post("resolve-login-id", { tenant_id: "not-a-uuid", login_id: "TC-0002" }, caller("notuuid"));
    expect([noId.status, noSchool.status, notAUuid.status]).toEqual([404, 404, 404]);
    expect(noSchool.text).toBe(noId.text);
    expect(notAUuid.text).toBe(noId.text);
  });

  it("asks for both a school and an ID, and refuses a body that is not JSON", async () => {
    expect((await post("resolve-login-id", { tenant_id: school.id }, caller("missing"))).status).toBe(400);
    expect((await post("resolve-login-id", "not json", caller("notjson"))).status).toBe(400);
  });

  it("stops one caller after 30 lookups in the window, and says so", async () => {
    const same = caller("limit");
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await post("resolve-login-id", { tenant_id: school.id, login_id: "TC-0002" }, same)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    const refused = await post("resolve-login-id", { tenant_id: school.id, login_id: "TC-0002" }, same);
    expect(refused.json.error).toBe("Too many attempts. Wait a few minutes and try again.");
  }, 60_000);

  // The caller's identity is a hash of cf-connecting-ip, else the FIRST x-forwarded-for value: both are headers the caller sets.
  // Behind Cloudflare the first is set by the platform; anywhere else (this local stack, a self-hosted or AWS deployment without a
  // proxy that overwrites it) the caller picks their own identity, so the limit never applies to someone who changes it.
  it.fails("FIG-1336 (open): a caller cannot get a fresh allowance by changing a header", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      statuses.push((await post("resolve-login-id", { tenant_id: school.id, login_id: "TC-0002" }, { "x-forwarded-for": `qa8-${run}-rotate-${i}`, "cf-connecting-ip": `qa8-${run}-cf-${i}` })).status);
    }
    expect(statuses.filter((s) => s === 429).length, "lookups refused after 30").toBeGreaterThan(0);
  }, 60_000);
});

describe("signup-organization", () => {
  const invalid = { name: "A", slug: "x", kind: "nope", admin_full_name: "", admin_email: "no-at-sign", admin_password: "short" };

  it("asks for what it needs in plain sentences, and creates nothing for a bad request", async () => {
    for (const [body, words] of [
      [{ ...invalid }, /name/i],
      [{ ...invalid, name: "Valid Name", slug: "x" }, /address/i],
      [{ ...invalid, name: "Valid Name", slug: "valid-slug-name" }, /kind/i],
      [{ ...invalid, name: "Valid Name", slug: "valid-slug-name", kind: "county", admin_full_name: "Grace" }, /email/i],
      [{ ...invalid, name: "Valid Name", slug: "valid-slug-name", kind: "county", admin_full_name: "Grace", admin_email: "g@example.com" }, /password/i],
    ] as [Record<string, unknown>, RegExp][]) {
      const res = await post("signup-organization", body, caller("shape"));
      expect(res.status).toBe(400);
      expect(String(res.json.error)).toMatch(words);
      expect(res.text).not.toMatch(/relation|violates|postgres|constraint/i);
    }
  });

  it("reserves the platform's own addresses", async () => {
    const res = await post("signup-organization", { ...invalid, name: "Valid Name", slug: "admin" }, caller("reserved"));
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/reserved/i);
  });

  it("stops one caller after 5 attempts in the hour; a refused attempt counts too", async () => {
    const same = caller("signup-limit");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post("signup-organization", invalid, same)).status);
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
