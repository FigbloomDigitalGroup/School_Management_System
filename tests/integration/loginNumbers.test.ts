import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInAs, type SignedIn } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * FIG-1468 (QA 15): next_login_number reserves the number it hands out.
 *
 * It used to read "the highest number plus one" without reserving it, so simultaneous account creations were handed the same number
 * and all but one failed with "Database error creating new user". This fires six provision-student calls at the same moment, as the
 * school admin, for six throwaway learners (QA15-LN-...) and expects six different logins. The same learners are deleted at the end,
 * which removes their logins (FIG-1419).
 */

const run = Date.now().toString(36);
const base = () => assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin;
const anonKey = () => process.env.VITE_SUPABASE_ANON_KEY!;

interface Reply { status: number; body: { error?: string; ok?: boolean; login_id?: string } }
async function provision(token: string, tenantId: string, studentId: string): Promise<Reply> {
  const res = await fetch(`${base()}/functions/v1/provision-student`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey(), Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tenant_id: tenantId, student_id: studentId }),
  });
  const text = await res.text();
  let body: Reply["body"] = {};
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
  return { status: res.status, body };
}

let admin: SignedIn;
let token = "";
let tenantId = "";
let classId = "";
const made: string[] = [];

async function addLearners(count: number, tag: string): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    tenant_id: tenantId, admission_no: `QA15-LN-${run}-${tag}${i + 1}`, full_name: `QA15 Login Number ${tag}${i + 1}`,
    class_id: classId, boarding: false, active: true, gender: i % 2 ? "male" : "female",
  }));
  const r = await admin.client.from("students").insert(rows).select("id");
  expect(r.error).toBeNull();
  const ids = (r.data ?? []).map((s) => s.id as string);
  made.push(...ids);
  return ids;
}

beforeAll(async () => {
  admin = await signInAs("school_admin");
  token = (await admin.client.auth.getSession()).data.session!.access_token;
  tenantId = (await admin.client.from("profiles").select("tenant_id").eq("id", admin.userId).single()).data!.tenant_id as string;
  classId = (await admin.client.from("classes").select("id").eq("tenant_id", tenantId).order("id").limit(1).single()).data!.id as string;
}, 60_000);

afterAll(async () => {
  // deleting a learner with nothing on file removes the learner and their login
  if (made.length) await admin.client.from("students").delete().in("id", made);
  const left = await admin.client.from("students").select("id", { count: "exact", head: true }).like("admission_no", `QA15-LN-${run}-%`);
  expect(left.count, "the throwaway learners were removed").toBe(0);
}, 60_000);

describe("FIG-1468: login numbers are reserved", () => {
  let top = 0;

  it("six accounts created at the same moment all get a login, each with its own number", async () => {
    const ids = await addLearners(6, "A");
    const replies = await Promise.all(ids.map((id) => provision(token, tenantId, id)));
    const failed = replies.filter((r) => r.status !== 200);
    expect(failed.map((r) => `${r.status} ${r.body.error}`), "every call succeeded").toEqual([]);
    const logins = replies.map((r) => r.body.login_id!);
    expect(new Set(logins).size, `six different logins: ${logins.join(", ")}`).toBe(6);
    expect(logins.every((l) => /^ST-\d{4}$/.test(l))).toBe(true);
    top = Math.max(...logins.map((l) => Number(l.slice(3))));
  }, 120_000);

  it("a number that was handed out is not handed out again, even after the newest account is removed", async () => {
    // remove the account that holds the highest number (deleting its learner removes the login), then make a new one
    const holder = await admin.client.from("profiles").select("id").eq("tenant_id", tenantId).eq("login_id", `ST-${String(top).padStart(4, "0")}`).single();
    expect(holder.error).toBeNull();
    const owner = await admin.client.from("students").select("id").eq("profile_id", holder.data!.id as string).single();
    expect(owner.error).toBeNull();
    expect((await admin.client.from("students").delete().eq("id", owner.data!.id as string)).error).toBeNull();
    const [fresh] = await addLearners(1, "B");
    const reply = await provision(token, tenantId, fresh!);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(Number(reply.body.login_id!.slice(3)), `the new login ${reply.body.login_id} is above the removed ST-${top}`).toBeGreaterThan(top);
  }, 120_000);
});
