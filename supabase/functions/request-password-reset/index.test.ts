import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { SIGN_IN_STATUSES } from "../_shared/signInStatuses.ts";
import { handle } from "./index.ts";

const TENANT_ID = "tenant-1";
const ONBOARDING_TENANT_ID = "tenant-2";

function makeClient() {
  const admin = new FakeSupabaseClient();
  admin.seed("tenants", [
    { id: TENANT_ID, slug: "green-valley", status: "active" },
    { id: ONBOARDING_TENANT_ID, slug: "riverside", status: "onboarding" },
  ]);
  admin.seed("profiles", [
    { id: "student-1", tenant_id: TENANT_ID, role: "student", full_name: "Esther Wanjiru", login_id: "ST-0001" },
    { id: "teacher-2", tenant_id: ONBOARDING_TENANT_ID, role: "teacher", full_name: "Someone Else", login_id: "TC-0001" },
  ]);
  admin.seed("password_reset_requests", []);
  return admin;
}

function request(body: unknown, opts: { method?: string } = {}) {
  const method = opts.method ?? "POST";
  return new Request("https://example.com/request-password-reset", {
    method,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const deps = (admin: FakeSupabaseClient, withinLimit = async () => true) => ({ admin, withinLimit });

describe("request-password-reset handle", () => {
  it("answers an OPTIONS preflight with CORS headers", async () => {
    const res = await handle(request({}, { method: "OPTIONS" }), deps(makeClient()));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const res = await handle(request({}, { method: "GET" }), deps(makeClient()));
    assertEquals(res.status, 405);
  });

  it("rejects a body missing the school or the ID", async () => {
    const res = await handle(request({ tenant_id: TENANT_ID }), deps(makeClient()));
    assertEquals(res.status, 400);
  });

  it("records an open request for a real ID, whatever case it was typed in", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "st-0001" }), deps(admin));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    const rows = admin.rowsIn("password_reset_requests");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].profile_id, "student-1");
    assertEquals(rows[0].tenant_id, TENANT_ID);
  });

  it("does not queue a second request while one is open", async () => {
    const admin = makeClient();
    await handle(request({ tenant_id: TENANT_ID, login_id: "ST-0001" }), deps(admin));
    await handle(request({ tenant_id: TENANT_ID, login_id: "ST-0001" }), deps(admin));
    assertEquals(admin.rowsIn("password_reset_requests").length, 1);
  });

  it("queues a new request once the earlier one was resolved", async () => {
    const admin = makeClient();
    admin.seed("password_reset_requests", [{ id: "r1", tenant_id: TENANT_ID, profile_id: "student-1", resolved_at: "2026-10-01T00:00:00Z" }]);
    await handle(request({ tenant_id: TENANT_ID, login_id: "ST-0001" }), deps(admin));
    assertEquals(admin.rowsIn("password_reset_requests").length, 2);
  });

  it("answers exactly the same for an ID that doesn't exist, and records nothing", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "ST-9999" }), deps(admin));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(admin.rowsIn("password_reset_requests").length, 0);
  });

  for (const status of ["trial", "overdue"]) {
    it(`records a request at a school on '${status}', which can sign in (FIG-1341)`, async () => {
      const admin = makeClient();
      admin.seed("tenants", [{ id: TENANT_ID, slug: "green-valley", status }]);
      const res = await handle(request({ tenant_id: TENANT_ID, login_id: "ST-0001" }), deps(admin));
      assertEquals(res.status, 200);
      assertEquals(admin.rowsIn("password_reset_requests").length, 1);
    });
  }

  it("records nothing for a school that isn't open for sign-in", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: ONBOARDING_TENANT_ID, login_id: "TC-0001" }), deps(admin));
    assertEquals(res.status, 200);
    assertEquals(admin.rowsIn("password_reset_requests").length, 0);
  });

  it("refuses once the caller is over the limit, before looking anything up", async () => {
    const admin = makeClient();
    const res = await handle(request({ tenant_id: TENANT_ID, login_id: "ST-0001" }), deps(admin, async () => false));
    assertEquals(res.status, 429);
    assertEquals(admin.rowsIn("password_reset_requests").length, 0);
  });
});

// QA 08 (FIG-1241): a school can sign in when its status is in SIGN_IN_STATUSES (active, trial, overdue), but this function only
// accepts 'active'. Someone at a school on trial or with an overdue invoice who taps "Forgot password?" is told it worked and
// no request reaches the office.
describe("request-password-reset: every school that can sign in can ask for a reset", () => {
  const withSchool = (status: string) => {
    const admin = makeClient();
    admin.seed("tenants", [
      { id: TENANT_ID, slug: "green-valley", status: "active" },
      { id: ONBOARDING_TENANT_ID, slug: "riverside", status: "onboarding" },
      { id: "tenant-3", slug: "hilltop", status },
    ]);
    admin.seed("profiles", [
      { id: "student-1", tenant_id: TENANT_ID, role: "student", full_name: "Esther Wanjiru", login_id: "ST-0001" },
      { id: "student-3", tenant_id: "tenant-3", role: "student", full_name: "Grace Atieno", login_id: "ST-0001" },
    ]);
    return admin;
  };

  it("records a request for a school that is active (control)", async () => {
    const admin = withSchool("active");
    await handle(request({ tenant_id: "tenant-3", login_id: "ST-0001" }), deps(admin));
    assertEquals(admin.rowsIn("password_reset_requests").length, 1);
  });

  for (const status of SIGN_IN_STATUSES.filter((s) => s !== "active")) {
    it(`FIG-1341: records a request for a school on '${status}', which can sign in`, async () => {
      const admin = withSchool(status);
      const res = await handle(request({ tenant_id: "tenant-3", login_id: "ST-0001" }), deps(admin));
      assertEquals(res.status, 200);
      assertEquals(admin.rowsIn("password_reset_requests").length, 1);
    });
  }

  it("records nothing for a school that cannot sign in (setup stalled, suspended)", async () => {
    for (const status of ["setup_stalled", "suspended"]) {
      const admin = withSchool(status);
      await handle(request({ tenant_id: "tenant-3", login_id: "ST-0001" }), deps(admin));
      assertEquals(admin.rowsIn("password_reset_requests").length, 0, status);
    }
  });
});
