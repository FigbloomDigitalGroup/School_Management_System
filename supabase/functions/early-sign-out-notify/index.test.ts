import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle, mayNotify } from "./index.ts";

// A throwaway RSA key made for each run, so no key is copied into the repo. It signs the test's own token request and nothing else.
async function testAccount() {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const b64 = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  return { project_id: "test-project", client_email: "test@test-project.iam.gserviceaccount.com", private_key: pem };
}

const SIGN_OUT = {
  id: "o1", tenant_id: "t1", student_id: "s1", student_name: "Amani Wanjiru Otieno", signed_out_local: "10:45:00",
  collected_by_name: "Jane Wanjiru", collected_by_relationship: "Aunt", recorded_by: "u1", voided_at: null, parent_pushed_at: null,
};

function clients(caller: Record<string, unknown>, opts: { areas?: string[]; signOut?: Record<string, unknown>; tokens?: boolean } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [{ id: "u1", tenant_id: "t1", ...caller }]);
  admin.seed("staff_permissions", (opts.areas ?? []).map((area) => ({ tenant_id: "t1", profile_id: "u1", area })));
  admin.seed("early_sign_outs", [{ ...SIGN_OUT, ...(opts.signOut ?? {}) }]);
  admin.seed("guardians", [{ profile_id: "p1", student_id: "s1" }, { profile_id: "p2", student_id: "s1" }, { profile_id: "p3", student_id: "other" }]);
  admin.seed("device_tokens", opts.tokens === false ? [] : [
    { id: "d1", token: "phone-1", profile_id: "p1" },
    { id: "d2", token: "phone-2", profile_id: "p2" },
    { id: "d3", token: "phone-3", profile_id: "p3" },
  ]);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: "u1" };
  return { admin, asUser };
}

const request = (body: unknown = { sign_out_id: "o1" }) => new Request("https://example.com/early-sign-out-notify", {
  method: "POST", headers: { Authorization: "Bearer token" }, body: JSON.stringify(body),
});

/** FCM's token endpoint, then each send: records who got what. */
function fakeFetch(sent: { token: string; title: string; body: string }[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    if (href.includes("fcm.googleapis.com")) {
      const { message } = JSON.parse(String(init?.body));
      sent.push({ token: message.token, title: message.notification.title, body: message.notification.body });
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${href}`);
  }) as unknown as typeof fetch;
}

Deno.test("whoever recorded it, the school's admin and the attendance area may ask for the push", async () => {
  const so = { tenant_id: "t1", recorded_by: "u1" };
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "teacher", tenant_id: "t1" }, so), true);
  assertEquals(await mayNotify(clients({}).admin, { id: "boss", role: "school_admin", tenant_id: "t1" }, so), true);
  assertEquals(await mayNotify(clients({}, { areas: ["attendance"] }).admin, { id: "u1", role: "staff", tenant_id: "t1" }, { tenant_id: "t1", recorded_by: "someone" }), true);
});

Deno.test("anyone else may not: another teacher, another area, another school, a parent", async () => {
  const so = { tenant_id: "t1", recorded_by: "someone" };
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "teacher", tenant_id: "t1" }, so), false);
  assertEquals(await mayNotify(clients({}, { areas: ["visitors"] }).admin, { id: "u1", role: "staff", tenant_id: "t1" }, so), false);
  assertEquals(await mayNotify(clients({}, { areas: ["attendance"] }).admin, { id: "u1", role: "staff", tenant_id: "t2" }, so), false);
  assertEquals(await mayNotify(clients({}).admin, { id: "boss", role: "school_admin", tenant_id: "t2" }, so), false);
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "parent", tenant_id: "t1" }, so), false);
});

Deno.test("a request needs a session, a sign-out id and a real sign-out", async () => {
  const noAuth = new Request("https://example.com/x", { method: "POST", body: "{}" });
  assertEquals((await handle(noAuth, { ...clients({ role: "teacher" }), account: null })).status, 401);
  assertEquals((await handle(request({}), { ...clients({ role: "teacher" }), account: null })).status, 400);
  // an id that does not exist answers exactly like one the caller may not use (no probing which sign-out ids exist)
  const missing = await handle(request({ sign_out_id: "nope" }), { ...clients({ role: "teacher" }), account: null });
  assertEquals(missing.status, 403);
  const refused = await handle(request(), { ...clients({ role: "teacher" }, { signOut: { recorded_by: "someone" } }), account: null });
  assertEquals(refused.status, 403);
  assertEquals(await missing.json(), await refused.json());
});

Deno.test("a teacher who did not record it, and has no attendance area, is refused", async () => {
  const res = await handle(request(), { ...clients({ role: "teacher" }, { signOut: { recorded_by: "someone" } }), account: null });
  assertEquals(res.status, 403);
});

Deno.test("with push not configured nothing is sent and nothing is marked as pushed", async () => {
  const c = clients({ role: "teacher" });
  const res = await handle(request(), { ...c, account: null });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).skipped, "push is not configured on this project");
  assertEquals(c.admin.rowsIn("early_sign_outs")[0]!.parent_pushed_at, null);
});

Deno.test("a voided sign-out is not pushed", async () => {
  const res = await handle(request(), { ...clients({ role: "teacher" }, { signOut: { voided_at: "2026-11-06T08:00:00Z" } }), account: await testAccount() }, fakeFetch([]));
  assertEquals((await res.json()).skipped, "this sign-out was voided");
});

Deno.test("with no parent on a phone nothing is marked, so a later call can still tell them", async () => {
  const c = clients({ role: "teacher" }, { tokens: false });
  const res = await handle(request(), { ...c, account: await testAccount() }, fakeFetch([]));
  assertEquals((await res.json()).skipped, "no parent has the app on a phone");
  assertEquals(c.admin.rowsIn("early_sign_outs")[0]!.parent_pushed_at, null);
});

Deno.test("if no phone is reached the marker is cleared, so a later call can retry", async () => {
  const c = clients({ role: "teacher" });
  const account = await testAccount();
  const failingFcm: typeof fetch = (async (url: string | URL) => {
    const href = url.toString();
    if (href.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  const res = await handle(request(), { ...c, account }, failingFcm);
  assertEquals(await res.json(), { sent: 0, failed: 2 });
  assertEquals(c.admin.rowsIn("early_sign_outs")[0]!.parent_pushed_at, null);

  const sent: { token: string; title: string; body: string }[] = [];
  const retry = await handle(request(), { ...c, account }, fakeFetch(sent));
  assertEquals(await retry.json(), { sent: 2, failed: 0 });
});

Deno.test("a provider failure is not echoed back to the caller, and the marker is cleared", async () => {
  const c = clients({ role: "teacher" });
  const account = await testAccount();
  const brokenToken: typeof fetch = (async () => { throw new Error("secret provider detail: key id 12345"); }) as unknown as typeof fetch;
  const res = await handle(request(), { ...c, account }, brokenToken);
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body, { error: "Could not send push notifications." });
  assertEquals(JSON.stringify(body).includes("secret provider detail"), false);
  assertEquals(c.admin.rowsIn("early_sign_outs")[0]!.parent_pushed_at, null);
});

Deno.test("the learner's parents, and only they, are told once", async () => {
  const c = clients({ role: "teacher" });
  const account = await testAccount();
  const sent: { token: string; title: string; body: string }[] = [];
  const res = await handle(request(), { ...c, account }, fakeFetch(sent));
  assertEquals(res.status, 200);
  assertEquals((await res.json()), { sent: 2, failed: 0 });
  assertEquals(sent.map((s) => s.token).sort(), ["phone-1", "phone-2"]);
  assertEquals(sent[0]!.title, "Amani was signed out early");
  assertEquals(sent[0]!.body, "Signed out at 10:45, collected by Jane Wanjiru (Aunt).");
  assertEquals(typeof c.admin.rowsIn("early_sign_outs")[0]!.parent_pushed_at, "string");

  // a second call, or a double click, pushes nothing more
  const again: { token: string; title: string; body: string }[] = [];
  const res2 = await handle(request(), { ...c, account }, fakeFetch(again));
  assertEquals((await res2.json()).skipped, "the parents were already told");
  assertEquals(again.length, 0);
});
