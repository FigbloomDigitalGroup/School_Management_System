import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle, MIN_SECRET_LENGTH } from "./index.ts";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"; // 48 characters
const NOW = new Date("2026-11-02T10:00:00.123Z");

const KILIMANI = "11111111-1111-4111-8111-111111111111";
const ALLIANCE = "22222222-2222-4222-8222-222222222222";
const TRIAL = "33333333-3333-4333-8333-333333333333";
const NOWHERE = "99999999-9999-4999-8999-999999999999";
const ORG = "44444444-4444-4444-8444-444444444444";

function makeAdmin() {
  const admin = new FakeSupabaseClient();
  admin.seed("organizations", [{ id: ORG, name: "Highlands Group", slug: "highlands", status: "active", contact_email: "owner@highlands.example" }]);
  admin.seed("tenants", [
    { id: KILIMANI, name: "Kilimani Secondary", slug: "kilimani-secondary", status: "active", organization_id: ORG, created_at: "2026-09-14T08:00:00Z", county: "Nairobi", plan: "standard", licensed_seats: 500 },
    { id: ALLIANCE, name: "Alliance High", slug: "alliance", status: "suspended", status_reason: "Unpaid licence", organization_id: null, created_at: "2026-09-01T06:30:00Z" },
    { id: TRIAL, name: "Trial Academy", slug: "trial-academy", status: "trial", organization_id: null, created_at: "2026-10-01T00:00:00Z" },
  ]);
  admin.seed("profiles", [
    // two admins: the first one created is the contact; the first-created has a synthetic address in Alliance
    { id: "p-admin-2", tenant_id: KILIMANI, role: "school_admin", full_name: "Second Admin", email: "deputy@kilimani.example", created_at: "2026-09-20T00:00:00Z" },
    { id: "p-admin-1", tenant_id: KILIMANI, role: "school_admin", full_name: "Head Teacher", email: "head@kilimani.example", created_at: "2026-09-14T08:00:00Z" },
    { id: "p-t1", tenant_id: KILIMANI, role: "teacher", full_name: "Teacher One", email: "tc-0001@login.kilimani-secondary.figbloom.internal" },
    { id: "p-t2", tenant_id: KILIMANI, role: "teacher", full_name: "Teacher Two" },
    { id: "p-par1", tenant_id: KILIMANI, role: "parent", full_name: "Parent One" },
    { id: "p-s1", tenant_id: KILIMANI, role: "student", full_name: "Learner One" },
    { id: "p-a-admin", tenant_id: ALLIANCE, role: "school_admin", full_name: "Alliance Admin", email: "ad-0001@login.alliance.figbloom.internal", created_at: "2026-09-01T00:00:00Z" },
    { id: "p-a-t1", tenant_id: ALLIANCE, role: "teacher", full_name: "Alliance Teacher" },
    { id: "p-super", tenant_id: null, role: "super_admin", full_name: "Figbloom Staff", email: "staff@figbloom.org" },
  ]);
  admin.seed("students", [
    { id: "s1", tenant_id: KILIMANI, full_name: "Learner One", active: true },
    { id: "s2", tenant_id: KILIMANI, full_name: "Learner Two", active: true },
    { id: "s3", tenant_id: KILIMANI, full_name: "Left Last Term", active: false },
    { id: "s4", tenant_id: ALLIANCE, full_name: "Alliance Learner", active: true },
  ]);
  admin.authUsers.set("p-t1", { id: "p-t1", last_sign_in_at: "2026-11-01T17:22:00.456Z" });
  admin.authUsers.set("p-par1", { id: "p-par1", last_sign_in_at: "2026-10-30T09:00:00Z" });
  admin.authUsers.set("p-super", { id: "p-super", last_sign_in_at: "2026-11-02T09:59:00Z" });
  return admin;
}

function deps(admin: FakeSupabaseClient, secret: string | undefined = SECRET) {
  return { admin, secret, now: () => NOW };
}

function call(body: unknown, { secret = SECRET as string | null, method = "POST" } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["x-platform-secret"] = secret;
  return new Request("https://example.com/functions/v1/platform-schools", {
    method,
    headers,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function suspend(overrides: Record<string, unknown> = {}) {
  return { action: "set_status", school_id: KILIMANI, status: "suspended", reason: "Licence unpaid since September", actor_email: "ops@figbloom.org", ...overrides };
}

async function errorOf(res: Response) {
  const body = await res.json();
  assertEquals(Object.keys(body), ["error"]);
  assertEquals(Object.keys(body.error).sort(), ["code", "message"]);
  return body.error as { code: string; message: string };
}

describe("platform-schools handle", () => {
  describe("the platform secret", () => {
    it("refuses a call with no x-platform-secret header", async () => {
      const res = await handle(call({ action: "list" }, { secret: null }), deps(makeAdmin()));
      assertEquals(res.status, 401);
      assertEquals((await errorOf(res)).code, "unauthorized");
    });

    it("refuses the wrong secret", async () => {
      const res = await handle(call({ action: "list" }, { secret: SECRET.slice(0, -1) + "x" }), deps(makeAdmin()));
      assertEquals(res.status, 401);
    });

    it("refuses a secret that only shares a prefix with the real one", async () => {
      const res = await handle(call({ action: "list" }, { secret: SECRET + "extra" }), deps(makeAdmin()));
      assertEquals(res.status, 401);
    });

    it("refuses every call when no secret is configured, even an empty header", async () => {
      for (const header of [null, ""]) {
        const res = await handle(call({ action: "list" }, { secret: header }), deps(makeAdmin(), undefined));
        assertEquals(res.status, 401);
      }
    });

    it("refuses every call when the configured secret is shorter than 32 characters, even with that secret", async () => {
      const short = "a".repeat(MIN_SECRET_LENGTH - 1);
      const res = await handle(call({ action: "list" }, { secret: short }), deps(makeAdmin(), short));
      assertEquals(res.status, 401);
    });

    it("accepts a configured secret of exactly 32 characters", async () => {
      const exact = "b".repeat(MIN_SECRET_LENGTH);
      const res = await handle(call({ action: "list" }, { secret: exact }), deps(makeAdmin(), exact));
      assertEquals(res.status, 200);
    });

    it("checks the secret before anything else, so a bad body still gets 401 and changes nothing", async () => {
      const admin = makeAdmin();
      const res = await handle(call(suspend(), { secret: "wrong" }), deps(admin));
      assertEquals(res.status, 401);
      assertEquals(admin.rowsIn("tenants").find((t) => t.id === KILIMANI)?.status, "active");
      assertEquals(admin.rowsIn("audit_events").length, 0);
    });
  });

  describe("the request", () => {
    it("refuses anything but POST", async () => {
      const res = await handle(call(null, { method: "GET" }), deps(makeAdmin()));
      assertEquals(res.status, 405);
      assertEquals((await errorOf(res)).code, "method_not_allowed");
    });

    it("answers 400 for a body that isn't JSON", async () => {
      const res = await handle(call("{not json"), deps(makeAdmin()));
      assertEquals(res.status, 400);
      assertEquals((await errorOf(res)).code, "invalid_json");
    });

    it("answers 400 for a JSON body that isn't an object", async () => {
      const res = await handle(call([1, 2]), deps(makeAdmin()));
      assertEquals(res.status, 400);
      assertEquals((await errorOf(res)).code, "invalid_body");
    });

    it("answers 400 for an unknown or missing action", async () => {
      for (const body of [{ action: "delete" }, {}]) {
        const res = await handle(call(body), deps(makeAdmin()));
        assertEquals(res.status, 400);
        assertEquals((await errorOf(res)).code, "unknown_action");
      }
    });
  });

  describe("list", () => {
    it("lists every school with counts, one contact and the last sign-in, in the contract's shape", async () => {
      const res = await handle(call({ action: "list" }), deps(makeAdmin()));
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(Object.keys(body).sort(), ["generated_at", "schools"]);
      assertEquals(body.generated_at, "2026-11-02T10:00:00Z");
      assertEquals(body.schools.map((s: { slug: string }) => s.slug), ["alliance", "kilimani-secondary", "trial-academy"]);

      const kilimani = body.schools.find((s: { id: string }) => s.id === KILIMANI);
      assertEquals(kilimani, {
        id: KILIMANI,
        name: "Kilimani Secondary",
        slug: "kilimani-secondary",
        status: "active",
        status_reason: null,
        organization: { id: ORG, name: "Highlands Group" },
        created_at: "2026-09-14T08:00:00Z",
        admin_email: "head@kilimani.example",
        students: 2,   // the archived learner doesn't count
        teachers: 2,
        parents: 1,
        last_activity_at: "2026-11-01T17:22:00Z",
      });
    });

    it("passes statuses through as Schools stores them, with the reason and no group", async () => {
      const body = await (await handle(call({ action: "list" }), deps(makeAdmin()))).json();
      const alliance = body.schools.find((s: { id: string }) => s.id === ALLIANCE);
      assertEquals(alliance.status, "suspended");
      assertEquals(alliance.status_reason, "Unpaid licence");
      assertEquals(alliance.organization, null);
      assertEquals(alliance.admin_email, null);          // the only admin has a login-ID address, not a mailbox
      assertEquals(alliance.last_activity_at, null);     // nobody there has signed in
      assertEquals([alliance.students, alliance.teachers, alliance.parents], [1, 1, 0]);
      assertEquals(body.schools.find((s: { id: string }) => s.id === TRIAL).status, "trial");
    });

    it("returns nothing personal beyond admin_email, even if the database sent more", async () => {
      const admin = makeAdmin();
      admin.rpcAnswers = {};
      const real = admin.rpc.bind(admin);
      admin.rpc = async (name, args) => {
        const r = await real(name, args);
        return { ...r, data: (r.data as Record<string, unknown>[]).map((row) => ({ ...row, plan: "standard", head_name: "Head Teacher", phone: "0700 000 000" })) };
      };
      const body = await (await handle(call({ action: "list" }), deps(admin))).json();
      for (const row of body.schools) {
        assertEquals(Object.keys(row).sort(), [
          "admin_email", "created_at", "id", "last_activity_at", "name", "organization", "parents",
          "slug", "status", "status_reason", "students", "teachers",
        ]);
      }
      const text = JSON.stringify(body);
      for (const name of ["Learner One", "Teacher One", "Parent One", "Head Teacher", "0700", "owner@highlands"]) {
        assert(!text.includes(name), `the list leaks "${name}"`);
      }
    });

    it("answers an empty list when there are no schools", async () => {
      const admin = new FakeSupabaseClient();
      const body = await (await handle(call({ action: "list" }), deps(admin))).json();
      assertEquals(body.schools, []);
    });

    it("answers 500 with a sentence, not the database's message, when the query fails", async () => {
      const admin = makeAdmin();
      admin.failNextRpc('relation "tenants" does not exist');
      const res = await handle(call({ action: "list" }), deps(admin));
      assertEquals(res.status, 500);
      const err = await errorOf(res);
      assertEquals(err.code, "internal_error");
      assert(!err.message.includes("relation"));
    });
  });

  describe("set_status", () => {
    it("suspends a school through tenants.status, with the reason and an audit event via the Figbloom console", async () => {
      const admin = makeAdmin();
      const res = await handle(call(suspend({ reason: "  Licence unpaid since September  " })), deps(admin));
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(Object.keys(body), ["school"]);
      assertEquals(body.school.id, KILIMANI);
      assertEquals(body.school.status, "suspended");
      assertEquals(body.school.status_reason, "Licence unpaid since September");
      assertEquals(body.school.students, 2);

      const tenant = admin.rowsIn("tenants").find((t) => t.id === KILIMANI)!;
      assertEquals(tenant.status, "suspended");
      assertEquals(tenant.status_before_suspension, "active");

      // the school's own audit log: Figbloom and the reason, never the staff member's address
      const school = admin.rowsIn("audit_events").filter((e) => e.tenant_id === KILIMANI);
      assertEquals(school.length, 1);
      assertEquals(school[0].actor_label, "Figbloom (via Figbloom console)");
      assertEquals(school[0].category, "access");
      assertEquals(school[0].event, "School suspended by Figbloom: Licence unpaid since September");
      assertEquals(school[0].metadata.reason, "Licence unpaid since September");
      assertEquals(school[0].metadata.changes, { status: { from: "active", to: "suspended" } });
      assert(!JSON.stringify(school[0]).includes("ops@figbloom.org"), "the school's audit event names the staff member");
      assert(!JSON.stringify(tenant).includes("ops@figbloom.org"), "the school's row names the staff member");
    });

    it("keeps the staff member's address only in an event with no school (Figbloom staff only)", async () => {
      const admin = makeAdmin();
      await handle(call(suspend()), deps(admin));
      const platform = admin.rowsIn("audit_events").filter((e) => e.tenant_id === null);
      assertEquals(platform.length, 1);
      assertEquals(platform[0].actor_label, "ops@figbloom.org via Figbloom console");
      assertEquals(platform[0].event, 'Suspended "Kilimani Secondary" via Figbloom console');
      assertEquals(platform[0].metadata.actor_email, "ops@figbloom.org");
      assertEquals(platform[0].metadata.school_id, KILIMANI);
    });

    it("reactivates a suspended school without a reason, and clears the old one", async () => {
      const admin = makeAdmin();
      const res = await handle(call({ action: "set_status", school_id: ALLIANCE, status: "active", actor_email: "ops@figbloom.org" }), deps(admin));
      assertEquals(res.status, 200);
      const { school } = await res.json();
      assertEquals(school.status, "active");   // nothing remembered: back to active
      assertEquals(school.status_reason, null);
      const audit = admin.rowsIn("audit_events").filter((e) => e.tenant_id === ALLIANCE);
      assertEquals(audit.length, 1);
      assertEquals(audit[0].event, "School reactivated by Figbloom");
      assertEquals(audit[0].metadata.changes, { status: { from: "suspended", to: "active" } });
    });

    it("reactivating restores the status the school had before it was suspended, and forgets it", async () => {
      for (const before of ["trial", "overdue", "active"]) {
        const admin = makeAdmin();
        admin.rowsIn("tenants").find((t) => t.id === KILIMANI)!.status = before;
        assertEquals((await handle(call(suspend()), deps(admin))).status, 200);
        const res = await handle(call({ action: "set_status", school_id: KILIMANI, status: "active", actor_email: "ops@figbloom.org" }), deps(admin));
        assertEquals(res.status, 200);
        assertEquals((await res.json()).school.status, before);
        const tenant = admin.rowsIn("tenants").find((t) => t.id === KILIMANI)!;
        assertEquals(tenant.status, before);
        assertEquals(tenant.status_before_suspension, null);
        const last = admin.rowsIn("audit_events").filter((e) => e.tenant_id === KILIMANI).at(-1)!;
        assertEquals(last.metadata.changes, { status: { from: "suspended", to: before } });
      }
    });

    it("restores a status remembered from a suspension made in Schools' own console", async () => {
      const admin = makeAdmin();
      Object.assign(admin.rowsIn("tenants").find((t) => t.id === ALLIANCE)!, { status_before_suspension: "overdue" });
      const res = await handle(call({ action: "set_status", school_id: ALLIANCE, status: "active", actor_email: "ops@figbloom.org" }), deps(admin));
      assertEquals((await res.json()).school.status, "overdue");
    });

    it("keeps an optional reason on reactivation", async () => {
      const admin = makeAdmin();
      const res = await handle(call({ action: "set_status", school_id: ALLIANCE, status: "active", reason: "Paid in full", actor_email: "ops@figbloom.org" }), deps(admin));
      assertEquals((await res.json()).school.status_reason, "Paid in full");
    });

    it("suspends a school on trial too, remembering it was on trial", async () => {
      const admin = makeAdmin();
      const res = await handle(call(suspend({ school_id: TRIAL })), deps(admin));
      assertEquals(res.status, 200);
      assertEquals((await res.json()).school.status, "suspended");
      assertEquals(admin.rowsIn("tenants").find((t) => t.id === TRIAL)?.status_before_suspension, "trial");
    });

    it("suspends an overdue school, remembering it was overdue", async () => {
      const admin = makeAdmin();
      admin.rowsIn("tenants").find((t) => t.id === KILIMANI)!.status = "overdue";
      const res = await handle(call(suspend()), deps(admin));
      assertEquals(res.status, 200);
      assertEquals(admin.rowsIn("tenants").find((t) => t.id === KILIMANI)?.status_before_suspension, "overdue");
    });

    it("refuses to suspend a school still onboarding or whose setup stalled (422), changing nothing", async () => {
      for (const status of ["onboarding", "setup_stalled"]) {
        const admin = makeAdmin();
        admin.rowsIn("tenants").find((t) => t.id === KILIMANI)!.status = status;
        const res = await handle(call(suspend()), deps(admin));
        assertEquals(res.status, 422, status);
        const err = await errorOf(res);
        assertEquals(err.code, "status_not_settable");
        assertEquals(err.message, "Only a school that is active, on trial or overdue can be suspended from the Figbloom console.");
        const tenant = admin.rowsIn("tenants").find((t) => t.id === KILIMANI)!;
        assertEquals(tenant.status, status);
        assertEquals(tenant.status_before_suspension ?? null, null);
        assertEquals(admin.rowsIn("audit_events").length, 0);
      }
    });

    describe("400 bad input", () => {
      const cases: [string, Record<string, unknown>, string][] = [
        ["a missing school_id", { school_id: undefined }, "invalid_school_id"],
        ["a school_id that isn't a UUID", { school_id: "kilimani" }, "invalid_school_id"],
        ["a missing status", { status: undefined }, "invalid_status"],
        ["a status that isn't text", { status: 1 }, "invalid_status"],
        ["no reason for a suspension", { reason: undefined }, "reason_required"],
        ["a blank reason for a suspension", { reason: "   " }, "reason_required"],
        ["a reason that isn't text", { reason: 42 }, "invalid_reason"],
        ["a reason over 500 characters", { reason: "x".repeat(501) }, "reason_too_long"],
        ["no actor_email", { actor_email: undefined }, "invalid_actor_email"],
        ["an actor_email that isn't an address", { actor_email: "ops" }, "invalid_actor_email"],
      ];
      for (const [label, overrides, code] of cases) {
        it(`refuses ${label}`, async () => {
          const admin = makeAdmin();
          const res = await handle(call(suspend(overrides)), deps(admin));
          assertEquals(res.status, 400);
          assertEquals((await errorOf(res)).code, code);
          assertEquals(admin.rowsIn("tenants").find((t) => t.id === KILIMANI)?.status, "active");
          assertEquals(admin.rowsIn("audit_events").length, 0);
        });
      }

      it("accepts a reason of exactly 500 characters", async () => {
        const res = await handle(call(suspend({ reason: "x".repeat(500) })), deps(makeAdmin()));
        assertEquals(res.status, 200);
      });

      it("refuses an over-long reason on reactivation too", async () => {
        const res = await handle(call({ action: "set_status", school_id: ALLIANCE, status: "active", reason: "x".repeat(501), actor_email: "ops@figbloom.org" }), deps(makeAdmin()));
        assertEquals(res.status, 400);
        assertEquals((await errorOf(res)).code, "reason_too_long");
      });
    });

    it("answers 404 for a school that doesn't exist", async () => {
      const admin = makeAdmin();
      const res = await handle(call(suspend({ school_id: NOWHERE })), deps(admin));
      assertEquals(res.status, 404);
      assertEquals((await errorOf(res)).code, "school_not_found");
      assertEquals(admin.rowsIn("audit_events").length, 0);
    });

    it("answers 409 when the school is already suspended", async () => {
      const admin = makeAdmin();
      const res = await handle(call(suspend({ school_id: ALLIANCE })), deps(admin));
      assertEquals(res.status, 409);
      assertEquals((await errorOf(res)).code, "already_in_status");
      assertEquals(admin.rowsIn("tenants").find((t) => t.id === ALLIANCE)?.status_reason, "Unpaid licence");
      assertEquals(admin.rowsIn("audit_events").length, 0);
    });

    it("answers 409 not_suspended when reactivating a school that isn't suspended", async () => {
      for (const id of [KILIMANI, TRIAL]) {
        const admin = makeAdmin();
        const res = await handle(call({ action: "set_status", school_id: id, status: "active", actor_email: "ops@figbloom.org" }), deps(admin));
        assertEquals(res.status, 409);
        assertEquals((await errorOf(res)).code, "not_suspended");
        assertEquals(admin.rowsIn("audit_events").length, 0);
      }
    });

    it("answers 422 for a status the console can't set", async () => {
      for (const status of ["trial", "overdue", "onboarding", "setup_stalled", "deleted"]) {
        const admin = makeAdmin();
        const res = await handle(call(suspend({ status })), deps(admin));
        assertEquals(res.status, 422, status);
        assertEquals((await errorOf(res)).code, "status_not_settable");
        assertEquals(admin.rowsIn("tenants").find((t) => t.id === KILIMANI)?.status, "active");
      }
    });

    it("sends the trimmed reason, null for none, and the actor to the database function", async () => {
      const admin = makeAdmin();
      const calls: Record<string, unknown>[] = [];
      const real = admin.rpc.bind(admin);
      admin.rpc = (name, args) => { calls.push({ name, ...args }); return real(name, args); };
      await handle(call({ action: "set_status", school_id: ALLIANCE, status: "active", reason: "  ", actor_email: " ops@figbloom.org " }), deps(admin));
      assertEquals(calls, [{ name: "platform_console_set_school_status", p_school_id: ALLIANCE, p_status: "active", p_reason: null, p_actor_email: "ops@figbloom.org" }]);
    });

    it("answers 500 with a sentence when the database fails", async () => {
      const admin = makeAdmin();
      admin.failNextRpc("deadlock detected");
      const res = await handle(call(suspend()), deps(admin));
      assertEquals(res.status, 500);
      const err = await errorOf(res);
      assertEquals(err.code, "internal_error");
      assert(!err.message.includes("deadlock"));
    });
  });
});
