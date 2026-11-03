import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, signInAs, type SignedIn } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 03 (FIG-1236), edge functions: invite-admin, provision-student, provision-guardian and delete-account use the service-role
 * key, so row-level security does not protect them; the caller check inside each function is the only guard.
 *
 * The victim is the first demo school (Alliance). Every user of the second school (Kijani Ridge, from `npm run db:seed-org`), the
 * Kijani Ridge Group admin (an organization that does not own Alliance) and callers with no valid session call each function
 * aimed at Alliance. Each must be refused, and nothing in Alliance may change: no new accounts, no new logins, the throwaway
 * staff account created below still exists.
 *
 * Also covered: a caller who names their OWN school but another school's learner or staff member, and the school's own admin
 * trying to mint a second school_admin. The "school or organization is suspended but the caller still holds a valid token"
 * case needs a database change mid-test and is run by hand (see the QA 03 comment on FIG-1236).
 */

const PASSWORD = "figbloom-dev";
const OTHER = {
  school_admin: "head@kijaniridge.sc.ke",
  teacher: "tc-0001@login.kijani-ridge.figbloom.internal",
  parent: "pt-0001@login.kijani-ridge.figbloom.internal",
  student: "st-0001@login.kijani-ridge.figbloom.internal",
  driver: "bd-0001@login.kijani-ridge.figbloom.internal",
  org_admin: "group@kijaniridge.sc.ke",
} as const;
type Caller = keyof typeof OTHER | "anon_key" | "no_authorization";
const CALLERS: Caller[] = [...(Object.keys(OTHER) as (keyof typeof OTHER)[]), "anon_key", "no_authorization"];
/** Callers whose role passes the first gate, so the refusal must come from the "you do not administer this school" check. */
const ADMINS: Caller[] = ["school_admin", "org_admin"];

const base = () => assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin;
const anonKey = () => process.env.VITE_SUPABASE_ANON_KEY!;

interface Reply { status: number; body: { error?: string; ok?: boolean; login_id?: string } }
async function call(fn: string, token: string | null, payload: unknown): Promise<Reply> {
  const res = await fetch(`${base()}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: Reply["body"] = {};
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
  return { status: res.status, body };
}

let owner: SignedIn;
let ownerToken = "";
let aTid = "", kTid = "";
let aStudent = "", kStudent = "";
let fixtureId = "";
const tokens = new Map<Caller, string | null>();
let before = { profiles: 0, logins: 0 };

async function snapshot(client: SupabaseClient) {
  const profiles = (await client.from("profiles").select("id", { count: "exact", head: true })).count ?? -1;
  const logins = (await client.from("students").select("id", { count: "exact", head: true }).not("profile_id", "is", null)).count ?? -1;
  return { profiles, logins };
}

beforeAll(async () => {
  owner = await signInAs("school_admin");
  ownerToken = (await owner.client.auth.getSession()).data.session!.access_token;
  aTid = ((await owner.client.from("profiles").select("tenant_id").eq("id", owner.userId)).data?.[0]?.tenant_id as string) ?? "";
  aStudent = ((await owner.client.from("students").select("id").limit(1)).data?.[0]?.id as string) ?? "";
  for (const who of CALLERS) {
    if (who === "anon_key") { tokens.set(who, anonKey()); continue; }
    if (who === "no_authorization") { tokens.set(who, null); continue; }
    const c = anonClient();
    const { data, error } = await c.auth.signInWithPassword({ email: OTHER[who], password: PASSWORD });
    if (error || !data.session) throw new Error(`could not sign in as ${who} (${OTHER[who]}): ${error?.message}. Did you run npm run db:seed-org?`);
    tokens.set(who, data.session.access_token);
    if (who === "school_admin") {
      kTid = ((await c.from("profiles").select("tenant_id").eq("id", data.user.id)).data?.[0]?.tenant_id as string) ?? "";
      kStudent = ((await c.from("students").select("id").limit(1)).data?.[0]?.id as string) ?? "";
    }
  }
  expect([aTid, kTid, aStudent, kStudent].every(Boolean), "both schools need an id and a learner").toBe(true);

  // CONTROL, and the target of the delete attacks: the owner creates a throwaway staff account through invite-admin.
  const made = await call("invite-admin", ownerToken, { tenant_id: aTid, full_name: `QA03 fixture ${Date.now().toString(36)}`, role: "staff", staff_title: "QA03 fixture" });
  expect(made.status, `invite-admin as the school's own admin: ${JSON.stringify(made.body)}`).toBe(200);
  fixtureId = ((await owner.client.from("profiles").select("id").eq("login_id", made.body.login_id!).eq("tenant_id", aTid)).data?.[0]?.id as string) ?? "";
  expect(fixtureId).not.toBe("");
  before = await snapshot(owner.client);
}, 120_000);

afterAll(async () => {
  // CONTROL: the owner removes the fixture through delete-account (also cleans up).
  if (fixtureId) {
    const gone = await call("delete-account", ownerToken, { tenant_id: aTid, profile_id: fixtureId });
    expect([200], `delete-account as the school's own admin: ${JSON.stringify(gone.body)}`).toContain(gone.status);
  }
}, 60_000);

const calls: { fn: string; label: string; payload: () => unknown }[] = [
  { fn: "invite-admin", label: "add a teacher to Alliance", payload: () => ({ tenant_id: aTid, full_name: "QA03 Intruder", role: "teacher" }) },
  { fn: "invite-admin", label: "add a school admin to Alliance", payload: () => ({ tenant_id: aTid, full_name: "QA03 Intruder", role: "school_admin", email: "qa03-intruder@example.com" }) },
  { fn: "provision-student", label: "create a login for an Alliance learner", payload: () => ({ tenant_id: aTid, student_id: aStudent }) },
  { fn: "provision-guardian", label: "add a guardian for an Alliance learner", payload: () => ({ tenant_id: aTid, full_name: "QA03 Intruder", students: [{ student_id: aStudent, relationship: "guardian" }] }) },
  { fn: "delete-account", label: "delete an Alliance staff account", payload: () => ({ tenant_id: aTid, profile_id: fixtureId }) },
];

describe.each(CALLERS)("edge functions aimed at another school, called by %s", (who) => {
  it.each(calls)("$fn: $label is refused", async ({ fn, payload }) => {
    const r = await call(fn, tokens.get(who) ?? null, payload());
    expect([401, 403], `${fn} answered ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
    if (ADMINS.includes(who) && !(fn === "invite-admin" && who === "school_admin")) {
      expect(r.body.error, `${fn}`).toMatch(/do not administer this school|Only Figbloom staff/);
    }
  }, 60_000);
});

describe("a caller who names their OWN school but another school's record", () => {
  it("provision-student: another school's learner under their own school id is refused", async () => {
    const r = await call("provision-student", tokens.get("school_admin")!, { tenant_id: kTid, student_id: aStudent });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not belong to this school/);
  }, 60_000);

  it("provision-guardian: another school's learner under their own school id is refused", async () => {
    const r = await call("provision-guardian", tokens.get("school_admin")!, { tenant_id: kTid, full_name: "QA03 Intruder", students: [{ student_id: aStudent }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/do not belong to this school/);
  }, 60_000);

  it("delete-account: another school's staff member under their own school id is refused", async () => {
    const r = await call("delete-account", tokens.get("school_admin")!, { tenant_id: kTid, profile_id: fixtureId });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not belong to this school/);
  }, 60_000);

  it("invite-admin: a school's own admin cannot mint another school_admin (only the platform or the organization can)", async () => {
    const r = await call("invite-admin", ownerToken, { tenant_id: aTid, full_name: "QA03 Second Admin", role: "school_admin", email: "qa03-second-admin@example.com" });
    expect(r.status).toBe(403);
  }, 60_000);

  it("delete-account: a school's own admin cannot remove themself", async () => {
    const r = await call("delete-account", ownerToken, { tenant_id: aTid, profile_id: owner.userId });
    expect(r.status).toBe(400);
  }, 60_000);
});

describe("after every attack, Alliance is unchanged", () => {
  it("no account, login or staff member was added or removed, and the fixture is still there", async () => {
    const after = await snapshot(owner.client);
    expect(after).toEqual(before);
    const fixture = await owner.client.from("profiles").select("id").eq("id", fixtureId);
    expect(fixture.data).toHaveLength(1);
  }, 60_000);
});
