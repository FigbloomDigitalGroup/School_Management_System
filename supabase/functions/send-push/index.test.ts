import { describe, it, afterEach, beforeEach } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

// Test-only RSA key, generated for this suite. Never used for anything real.
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDN7BK/Gmy3+pj3
P3OvGZ2cIFiOogLkU1pOhyn6OM5jWjQqcxbGUU8nRlr3f/8zP6tTGqWDUc5NDCnS
MKdAXZEqauSE5v82otd6YkX8WIHbHqh7c5Y5Cr02uZyQOsKmkUmcg8U2g726ORQc
h+OjvK1zjXnBTqIryFP/83DqLmQG+25BTvUVAEDZOQEeyYi/mTGxXqgpRsUKhok2
IkMmCjozrR2acLREl7TJrCmaj1g3ZZ7SHCj560bRiqGHKSnxRh1qtgsfRg/Yci8p
cF6SkUuteSxcvPE3nDVIVj1Vg0RxiDsQ2I5v4UqpNCeU7gadl5i6xTEKS/unHS8I
m/TXOVr/AgMBAAECggEASJw2nAYwUctehshr/VE1/yh0sY61IFe33zrP9Xh0ZhoX
jORaIoHnPD0VtHIAxcxsl/gsZprA+PASCxi20P5tQpzAiZB+a4COJIxkiy+WUnKE
DEvcq656u8JFT6I4os1WPIdGUguwKesYiVrtTP4p1zYKubwFeRTBcd4gcaL8CG2c
I8zBnQAt8nEPcJAC+UhSCeAvMzcariKwLUw0rNMnQXxFpRIxIT7WWheMuTU0+M2o
+U7xhPVMOWVYrdH0Se9T8EeWi29hhqgA6THU2P4bwMfEfC5qbYkkMb6W8mvZclaB
XeZe4MWxvG3BPkNgG7Ajwqxmflwfo5tbW16X7GKFQQKBgQDq1ZsFjY3Tgc0jkLyO
Cq2yuyQ7HCDhtDrUeH1PXFRMrlFYjjpAVDgT5iw6k8KzuVSO3YW6Xk9R1PcdQZtP
YEdsw4qda/238OQPIx47BtAkV81gXXk/7WLsy+vf8cqtUV1IpdngTV4uPCLPM98P
1frQ+sR+rUcjxiwyk2gPQf9f4QKBgQDge15D8hXh87hISKz41M9dkh1NHs2IFeJw
pRdmFCJV6Y1z65FeBZ8Thh/6igpbEVoUV7bCZwY26jEOH6kasqG5tUFD29Qi4pYd
+RuUXZUIdjCseyC++MLrHIFPhRQ3p2hgmw3IKpe7hqcALSmdBo3z+aaIFN9gsbSA
RCDF5neW3wKBgQCv3038eKkxMFMsQaeVUZYI93MI+eX+Y3ZzzdE7cFCKJTsy8UHb
D7f33zhcnnEBHNmhLXKLwznwdWik9o+UgOy9Hi1f/JLGAZkrZQes+UtFDKT5eMfo
AqdF5OtAittZtkgAsoVcIVVZlxwSxixWtdDkVgp3PNq8hhxvvEoAs1LIwQKBgE+l
1iN7gKIkDG2xQ5YiQ9UqY7UaSciQI0DegrfYSvp6nJLVsUVP70pJG42Ubuoy9Ogk
2xaM4VqYq4EcYK61VMaEdjyygclC5gqKeWuh7KAM92YrZcn8j4RGH+dsC2lXv6QP
P8uWuTFzLEvWul4ZlkJLgPflmABB7Q5Znds505K3AoGAGsj21Y2kvjlZfhk2n9wC
tPH+b39i0xrXg9vdBZEJGIjjh6faV2cqUD7VcNJyiWi+0mRIFPEgw9oMT0Kimtxb
LobdRRVQufvoJTSh/L124VSilEfU3nrgiyjo7pLaSTGCAF60IIJStFPL2KwXW6KR
cSX+25JWTOuVVsORSeU5EjI=
-----END PRIVATE KEY-----`;

const SERVICE_ACCOUNT = JSON.stringify({
  project_id: "test-project", client_email: "test@test-project.iam.gserviceaccount.com", private_key: TEST_PRIVATE_KEY,
});

const SCHOOL_ADMIN_ID = "school-admin-1";
const TENANT_ID = "tenant-1";
const ANNOUNCEMENT_ID = "ann-1";

function makeClients() {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [{ id: SCHOOL_ADMIN_ID, role: "school_admin", tenant_id: TENANT_ID }]);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: SCHOOL_ADMIN_ID };
  return { admin, asUser };
}

function seedAnnouncement(admin: FakeSupabaseClient, overrides: Record<string, unknown> = {}) {
  admin.seed("announcements", [{
    id: ANNOUNCEMENT_ID, tenant_id: TENANT_ID, subject: "School closed Friday", body: "Half-term begins early.",
    audience: { kind: "whole_school" }, channels: ["in_app", "push"],
    ...overrides,
  }]);
}

function request(body: unknown = { announcement_id: ANNOUNCEMENT_ID }, opts: { method?: string; auth?: string | null } = {}) {
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/send-push", {
    method: opts.method ?? "POST", headers,
    body: opts.method === "GET" || opts.method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

/** Routes the mocked fetch: the FCM OAuth token endpoint, then FCM send. */
function fakeFetch(sendResult: (token: string) => Response | Promise<Response>): typeof fetch {
  return (async (url: string | URL) => {
    const href = url.toString();
    if (href.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
    }
    if (href.includes("fcm.googleapis.com")) {
      // Token isn't in the URL for FCM v1 (it's in the body) — read it out.
      return sendResult("");
    }
    throw new Error(`Unexpected fetch to ${href}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  Deno.env.set("FCM_SERVICE_ACCOUNT_JSON", SERVICE_ACCOUNT);
});
afterEach(() => {
  Deno.env.delete("FCM_SERVICE_ACCOUNT_JSON");
});

describe("send-push handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({}, { method: "OPTIONS", auth: null }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({}, { method: "GET" }), { admin, asUser });
    assertEquals(res.status, 405);
  });

  it("rejects a request with no Authorization header", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(undefined, { auth: null }), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects a body missing announcement_id", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({}), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("404s when the announcement does not exist", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ announcement_id: "missing" }), { admin, asUser });
    assertEquals(res.status, 404);
  });

  it("rejects a caller from a different tenant", async () => {
    const { admin, asUser } = makeClients();
    seedAnnouncement(admin, { tenant_id: "other-tenant" });
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("skips sending when the announcement's channels don't include push", async () => {
    const { admin, asUser } = makeClients();
    seedAnnouncement(admin, { channels: ["in_app"] });
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.sent, 0);
    assertEquals(typeof out.skipped, "string");
  });

  it("500s with a clear message when FCM_SERVICE_ACCOUNT_JSON is not set", async () => {
    Deno.env.delete("FCM_SERVICE_ACCOUNT_JSON");
    const { admin, asUser } = makeClients();
    seedAnnouncement(admin);
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 500);
  });

  it("sends to every device token for a whole_school audience", async () => {
    const { admin, asUser } = makeClients();
    seedAnnouncement(admin);
    admin.seed("profiles", [
      { id: SCHOOL_ADMIN_ID, role: "school_admin", tenant_id: TENANT_ID },
      { id: "parent-1", role: "parent", tenant_id: TENANT_ID },
      { id: "parent-2", role: "parent", tenant_id: TENANT_ID },
    ]);
    admin.seed("device_tokens", [
      { id: "dt1", profile_id: "parent-1", token: "tok-1", platform: "android" },
      { id: "dt2", profile_id: "parent-2", token: "tok-2", platform: "android" },
    ]);

    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ name: "projects/test/messages/1" }), { status: 200 }));
    const res = await handle(request(), { admin, asUser }, fetchImpl);
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.sent, 2);
    assertEquals(out.failed, 0);
    assertEquals(admin.rowsIn("device_tokens").length, 2);
  });

  it("resolves a class audience to its students and their guardians", async () => {
    const { admin, asUser } = makeClients();
    seedAnnouncement(admin, { audience: { kind: "class", class_id: "class-1" } });
    admin.seed("students", [
      { id: "student-1", tenant_id: TENANT_ID, class_id: "class-1", profile_id: "student-profile-1", active: true },
      { id: "student-2", tenant_id: TENANT_ID, class_id: "other-class", profile_id: "student-profile-2", active: true },
    ]);
    admin.seed("guardians", [
      { student_id: "student-1", profile_id: "parent-of-1" },
      { student_id: "student-2", profile_id: "parent-of-2" },
    ]);
    admin.seed("device_tokens", [
      { id: "dt1", profile_id: "student-profile-1", token: "tok-student-1", platform: "android" },
      { id: "dt2", profile_id: "parent-of-1", token: "tok-parent-1", platform: "android" },
      { id: "dt3", profile_id: "parent-of-2", token: "tok-parent-2", platform: "android" },
    ]);

    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ name: "ok" }), { status: 200 }));
    const res = await handle(request(), { admin, asUser }, fetchImpl);
    const out = await res.json();
    // Only student-1's class and their guardian — not student-2's parent.
    assertEquals(out.sent, 2);
  });

  it("resolves a form_level audience via the student's class", async () => {
    const { admin, asUser } = makeClients();
    seedAnnouncement(admin, { audience: { kind: "form_level", form_level: 2 } });
    admin.seed("students", [
      { id: "student-1", tenant_id: TENANT_ID, class_id: "c1", profile_id: null, active: true, classes: { form_level: 2 } },
      { id: "student-2", tenant_id: TENANT_ID, class_id: "c2", profile_id: null, active: true, classes: { form_level: 1 } },
    ]);
    admin.seed("guardians", [{ student_id: "student-1", profile_id: "parent-of-1" }]);
    admin.seed("device_tokens", [{ id: "dt1", profile_id: "parent-of-1", token: "tok-parent-1", platform: "android" }]);

    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ name: "ok" }), { status: 200 }));
    const res = await handle(request(), { admin, asUser }, fetchImpl);
    const out = await res.json();
    assertEquals(out.sent, 1);
  });

  it("counts a failed send and removes the token when FCM reports it as unregistered", async () => {
    const { admin, asUser } = makeClients();
    seedAnnouncement(admin);
    admin.seed("profiles", [
      { id: SCHOOL_ADMIN_ID, role: "school_admin", tenant_id: TENANT_ID },
      { id: "parent-1", role: "parent", tenant_id: TENANT_ID },
    ]);
    admin.seed("device_tokens", [{ id: "dt1", profile_id: "parent-1", token: "stale-token", platform: "android" }]);

    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { status: "UNREGISTERED" } }), { status: 404 }));
    const res = await handle(request(), { admin, asUser }, fetchImpl);
    const out = await res.json();
    assertEquals(out.sent, 0);
    assertEquals(out.failed, 1);
    assertEquals(admin.rowsIn("device_tokens").length, 0);
  });
});
