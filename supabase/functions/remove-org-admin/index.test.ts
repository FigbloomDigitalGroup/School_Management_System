import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const CALLER_ID = "org-admin-1";
const TARGET_ID = "org-admin-2";

interface Opts {
  callerRole?: string;
  orgStatus?: string;
  /** Whether the caller administers ORG_ID. */
  callerLinked?: boolean;
  /** Whether the target administers ORG_ID. */
  targetLinked?: boolean;
  /** Other organizations the target also administers. */
  targetAlsoAdministers?: string[];
  targetRole?: string;
}

function makeClients(opts: Opts = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: CALLER_ID, role: opts.callerRole ?? "org_admin", full_name: "Grace Wambui" },
    { id: TARGET_ID, role: opts.targetRole ?? "org_admin", full_name: "Peter Otieno", email: "peter@example.org" },
  ]);
  admin.seed("organizations", [
    { id: ORG_ID, name: "Kijani Ridge Group", status: opts.orgStatus ?? "active" },
    { id: OTHER_ORG_ID, name: "Riverside Trust", status: "active" },
  ]);
  admin.seed("organization_admins", [
    ...(opts.callerLinked === false ? [] : [{ id: "link-caller", profile_id: CALLER_ID, organization_id: ORG_ID }]),
    ...(opts.targetLinked === false ? [] : [{ id: "link-target", profile_id: TARGET_ID, organization_id: ORG_ID, added_by: CALLER_ID }]),
    ...(opts.targetAlsoAdministers ?? []).map((organization_id, i) => ({ id: `link-extra-${i}`, profile_id: TARGET_ID, organization_id })),
  ]);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: CALLER_ID };
  return { admin, asUser };
}

function request(body: unknown, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/remove-org-admin", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

const validBody = { organization_id: ORG_ID, profile_id: TARGET_ID };

const linksOf = (admin: FakeSupabaseClient, profileId: string) =>
  admin.rowsIn("organization_admins").filter((l) => l.profile_id === profileId).map((l) => l.organization_id);

describe("remove-org-admin handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody, { method: "OPTIONS", auth: null }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects non-POST requests", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody, { method: "GET" }), { admin, asUser });
    assertEquals(res.status, 405);
  });

  it("rejects a request with no Authorization header", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(validBody, { auth: null }), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects a caller whose token matches no user", async () => {
    const { admin, asUser } = makeClients();
    asUser.authUser = null;
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 401);
  });

  for (const role of ["school_admin", "teacher", "staff", "parent", "student", "driver"]) {
    it(`refuses a ${role}, even one who is somehow linked to the organization`, async () => {
      const { admin, asUser } = makeClients({ callerRole: role });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 403);
      assertEquals(linksOf(admin, TARGET_ID), [ORG_ID]);
      assertEquals(admin.deletedUserIds, []);
    });
  }

  it("rejects a body missing the organization or the admin", async () => {
    const { admin, asUser } = makeClients();
    assertEquals((await handle(request({ organization_id: ORG_ID }), { admin, asUser })).status, 400);
    assertEquals((await handle(request({ profile_id: TARGET_ID }), { admin, asUser })).status, 400);
  });

  it("rejects a body that is not JSON", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(new Request("https://example.com/remove-org-admin", { method: "POST", headers: { Authorization: "Bearer t" }, body: "nope" }), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("never lets anyone remove themselves", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ organization_id: ORG_ID, profile_id: CALLER_ID }), { admin, asUser });
    assertEquals(res.status, 400);
    assertEquals(linksOf(admin, CALLER_ID), [ORG_ID]);
  });

  it("404s when the organization does not exist", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ ...validBody, organization_id: "missing" }), { admin, asUser });
    assertEquals(res.status, 404);
  });

  it("rejects an org admin who does not administer this organization", async () => {
    const { admin, asUser } = makeClients({ callerLinked: false });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
    assertEquals(linksOf(admin, TARGET_ID), [ORG_ID]);
  });

  it("rejects an org admin of ANOTHER organization naming this one", async () => {
    const { admin, asUser } = makeClients({ callerLinked: false });
    admin.seed("organization_admins", [
      { id: "link-caller", profile_id: CALLER_ID, organization_id: OTHER_ORG_ID },
      { id: "link-target", profile_id: TARGET_ID, organization_id: ORG_ID },
    ]);
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
    assertEquals(linksOf(admin, TARGET_ID), [ORG_ID]);
  });

  it("refuses an org admin whose organization is suspended (FIG-1312)", async () => {
    const { admin, asUser } = makeClients({ orgStatus: "suspended" });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 403);
    assertEquals(linksOf(admin, TARGET_ID), [ORG_ID]);
    assertEquals(admin.deletedUserIds, []);
  });

  it("404s when the person is not an admin of this organization", async () => {
    const { admin, asUser } = makeClients({ targetLinked: false, targetAlsoAdministers: [OTHER_ORG_ID] });
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 404);
    // their other organization is untouched
    assertEquals(linksOf(admin, TARGET_ID), [OTHER_ORG_ID]);
    assertEquals(admin.deletedUserIds, []);
  });

  describe("an org admin removing a co-admin", () => {
    it("takes out the link, the profile and the login when it was their only organization", async () => {
      const { admin, asUser } = makeClients();
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, removedAccount: true });
      assertEquals(linksOf(admin, TARGET_ID), []);
      assertEquals(admin.rowsIn("profiles").find((p) => p.id === TARGET_ID), undefined);
      assertEquals(admin.deletedUserIds, [TARGET_ID]);
      // the caller is untouched
      assertEquals(linksOf(admin, CALLER_ID), [ORG_ID]);
      assertEquals(admin.rowsIn("profiles").find((p) => p.id === CALLER_ID)?.id, CALLER_ID);
    });

    it("keeps the login when they still administer another organization", async () => {
      const { admin, asUser } = makeClients({ targetAlsoAdministers: [OTHER_ORG_ID] });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, removedAccount: false });
      assertEquals(linksOf(admin, TARGET_ID), [OTHER_ORG_ID]);
      assertEquals(admin.rowsIn("profiles").find((p) => p.id === TARGET_ID)?.id, TARGET_ID);
      assertEquals(admin.deletedUserIds, []);
    });

    it("leaves a profile that is not an org admin alone (only the stray link goes)", async () => {
      const { admin, asUser } = makeClients({ targetRole: "teacher" });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).removedAccount, false);
      assertEquals(linksOf(admin, TARGET_ID), []);
      assertEquals(admin.rowsIn("profiles").find((p) => p.id === TARGET_ID)?.id, TARGET_ID);
      assertEquals(admin.deletedUserIds, []);
    });
  });

  describe("a super_admin", () => {
    it("removes an org admin from any organization, even one they are not linked to", async () => {
      const { admin, asUser } = makeClients({ callerRole: "super_admin", callerLinked: false });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      assertEquals(linksOf(admin, TARGET_ID), []);
      assertEquals(admin.deletedUserIds, [TARGET_ID]);
    });

    it("may remove the last admin of an organization (and add another after)", async () => {
      const { admin, asUser } = makeClients({ callerRole: "super_admin", callerLinked: false });
      assertEquals(admin.rowsIn("organization_admins").filter((l) => l.organization_id === ORG_ID).length, 1);
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
      assertEquals(admin.rowsIn("organization_admins").filter((l) => l.organization_id === ORG_ID).length, 0);
    });

    it("may act on a suspended organization", async () => {
      const { admin, asUser } = makeClients({ callerRole: "super_admin", orgStatus: "suspended" });
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 200);
    });
  });

  describe("the audit log", () => {
    it("says who removed whom, and from which organization", async () => {
      const { admin, asUser } = makeClients();
      await handle(request(validBody), { admin, asUser });
      const [entry, ...rest] = admin.rowsIn("audit_events");
      assertEquals(rest.length, 0);
      assertEquals(entry?.tenant_id, null);
      assertEquals(entry?.actor_label, "Grace Wambui · org admin");
      assertEquals(entry?.event, "Org admin Peter Otieno removed from Kijani Ridge Group");
      assertEquals(entry?.category, "provisioning");
    });

    it("labels Figbloom staff as such", async () => {
      const { admin, asUser } = makeClients({ callerRole: "super_admin" });
      await handle(request(validBody), { admin, asUser });
      assertEquals(admin.rowsIn("audit_events")[0]?.actor_label, "Grace Wambui · Figbloom");
    });

    it("writes nothing when the removal is refused", async () => {
      const { admin, asUser } = makeClients({ callerLinked: false });
      await handle(request(validBody), { admin, asUser });
      assertEquals(admin.rowsIn("audit_events"), []);
    });

    it("puts the removal back, and removes nobody, when the entry cannot be written", async () => {
      const { admin, asUser } = makeClients();
      admin.failNextWrite("audit_events", "audit_events is read only right now");
      const res = await handle(request(validBody), { admin, asUser });
      assertEquals(res.status, 500);
      assertMatch((await res.json()).error, /audit log/);
      assertEquals(linksOf(admin, TARGET_ID), [ORG_ID]);
      assertEquals(admin.rowsIn("profiles").find((p) => p.id === TARGET_ID)?.id, TARGET_ID);
      assertEquals(admin.deletedUserIds, []);
      // the restored link is the same row they had, down to who added them
      assertEquals(admin.rowsIn("organization_admins").find((l) => l.id === "link-target")?.added_by, CALLER_ID);
    });
  });

  it("answers a generic sentence, not the database's own, when the link cannot be deleted", async () => {
    const { admin, asUser } = makeClients();
    // delete is a write: the first write to organization_admins fails
    admin.failNextWrite("organization_admins", "permission denied for table organization_admins");
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 500);
    const out = await res.json();
    assertMatch(out.error, /Could not remove them from the organization/);
    assertEquals(String(out.error).includes("permission denied"), false);
    assertEquals(linksOf(admin, TARGET_ID), [ORG_ID]);
    assertEquals(admin.deletedUserIds, []);
  });

  it("keeps the profile, and says so, when a foreign key still points at it", async () => {
    const { admin, asUser } = makeClients();
    admin.failNextWrite("profiles", "update or delete on table \"profiles\" violates foreign key constraint \"x_fkey\"");
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.removedAccount, false);
    assertMatch(out.warning, /Peter Otieno was removed from Kijani Ridge Group/);
    assertMatch(out.warning, /can no longer see anything/);
    // the access is gone even though the account could not be
    assertEquals(linksOf(admin, TARGET_ID), []);
    assertEquals(admin.rowsIn("profiles").find((p) => p.id === TARGET_ID)?.id, TARGET_ID);
    assertEquals(admin.deletedUserIds, []);
  });

  it("still reports success, with a warning, if the login itself fails to delete", async () => {
    const { admin, asUser } = makeClients();
    const originalDeleteUser = admin.auth.admin.deleteUser;
    // deno-lint-ignore no-explicit-any
    (admin.auth.admin as any).deleteUser = async (id: string) => {
      await originalDeleteUser(id);
      return { error: { message: "auth service unavailable" } };
    };
    const res = await handle(request(validBody), { admin, asUser });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.ok, true);
    assertEquals(out.removedAccount, true);
    assertMatch(out.warning, /Peter Otieno was removed/);
    assertEquals(String(out.warning).includes("auth service unavailable"), false);
  });
});
