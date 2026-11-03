import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { signFigbloomWebhook } from "../_shared/platformWebhook.ts";
import { handle } from "./index.ts";

const SECRET = "w".repeat(64);
const NOW = Date.parse("2026-11-03T10:00:00Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const PRIMARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECONDARY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeDb({ enabled = true, status = "active" } = {}) {
  const db = new FakeSupabaseClient();
  db.platformDecisionsEnabled = enabled;
  db.seed("organizations", [{ id: ORG, name: "Hillside Schools", slug: "hillside", status }]);
  db.seed("tenants", [
    { id: PRIMARY, name: "Hillside Primary", organization_id: ORG, status: "active" },
    { id: SECONDARY, name: "Hillside Secondary", organization_id: ORG, status: "trial" },
  ]);
  return db;
}

function decision(status: string, extra: Record<string, unknown> = {}, org: Record<string, unknown> = {}) {
  return JSON.stringify({
    organization: { id: "platform-org-9", local_id: ORG, status, status_reason: status === "suspended" ? "Fees unpaid" : null, ...org },
    decided_by: "console:ann@figbloom.org",
    decided_at: "2026-11-03T09:59:00.000Z",
    ...extra,
  });
}

async function deliver(db: FakeSupabaseClient, body: string, opts: { delivery?: string; at?: number; secret?: string; signature?: string; timestamp?: string; event?: string } = {}) {
  const signed = await signFigbloomWebhook(opts.secret ?? SECRET, body, opts.at ?? NOW);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-figbloom-event": opts.event ?? "organization.status_changed",
    "x-figbloom-delivery": opts.delivery ?? "42",
    "x-figbloom-timestamp": opts.timestamp ?? signed.timestamp,
    "x-figbloom-signature": opts.signature ?? signed.signature,
  };
  return handle(new Request("https://schools.test/functions/v1/platform-decisions", { method: "POST", headers, body }), { admin: db, secret: SECRET, now: () => NOW });
}

const orgStatus = (db: FakeSupabaseClient) => db.rowsIn("organizations")[0].status;

describe("platform-decisions", () => {
  describe("verification", () => {
    it("refuses a bad signature and changes nothing", async () => {
      const db = makeDb();
      const res = await deliver(db, decision("suspended"), { secret: "x".repeat(64) });
      assertEquals(res.status, 401);
      assertEquals(orgStatus(db), "active");
      assertEquals(db.rowsIn("platform_webhook_deliveries").length, 0);
    });

    it("refuses a body changed after signing", async () => {
      const db = makeDb();
      const signed = await signFigbloomWebhook(SECRET, decision("active"), NOW);
      const res = await deliver(db, decision("suspended"), { signature: signed.signature, timestamp: signed.timestamp });
      assertEquals(res.status, 401);
      assertEquals(orgStatus(db), "active");
    });

    it("refuses a stale timestamp (a captured request replayed later)", async () => {
      const db = makeDb();
      const res = await deliver(db, decision("suspended"), { at: NOW - 6 * 60_000 });
      assertEquals(res.status, 401);
      assertEquals(orgStatus(db), "active");
    });

    it("refuses everything when the secret isn't set", async () => {
      const db = makeDb();
      const body = decision("suspended");
      const signed = await signFigbloomWebhook(SECRET, body, NOW);
      const res = await handle(new Request("https://s.test/f", {
        method: "POST", body,
        headers: { "x-figbloom-delivery": "1", "x-figbloom-signature": signed.signature, "x-figbloom-timestamp": signed.timestamp },
      }), { admin: db, secret: undefined, now: () => NOW });
      assertEquals(res.status, 401);
    });

    it("refuses anything but POST", async () => {
      const res = await handle(new Request("https://s.test/f"), { admin: makeDb(), secret: SECRET });
      assertEquals(res.status, 405);
    });
  });

  describe("applying a decision", () => {
    it("suspends the organisation through organizations.status, with a Figbloom event for each school and a staff-only one", async () => {
      const db = makeDb();
      const res = await deliver(db, decision("suspended"));
      assertEquals(res.status, 200);
      assertEquals((await res.json()).outcome, "applied");
      assertEquals(orgStatus(db), "suspended");

      const audit = db.rowsIn("audit_events");
      const schools = audit.filter((e) => e.tenant_id && e.event.startsWith("Organization"));
      assertEquals(schools.map((e) => e.tenant_id).sort(), [PRIMARY, SECONDARY]);
      assert(audit.filter((e) => e.tenant_id).every((e) => !JSON.stringify(e).includes("ann@figbloom.org")));
      for (const e of schools) {
        assertEquals(e.actor_label, "Figbloom (via Figbloom platform)");
        assertEquals(e.event, 'Organization "Hillside Schools" suspended by Figbloom: Fees unpaid');
        assert(!JSON.stringify(e).includes("ann@figbloom.org"), "a school can read this event: no staff address");
      }
      const staff = audit.filter((e) => !e.tenant_id);
      assertEquals(staff.length, 1);
      assertEquals(staff[0].actor_label, "console:ann@figbloom.org via Figbloom platform");
      assertEquals(staff[0].metadata.decided_by, "console:ann@figbloom.org");
      assertEquals(staff[0].metadata.delivery_id, "42");
      assertEquals(staff[0].metadata.changes, { status: { from: "active", to: "suspended" } });
    });

    it("reactivates it the same way", async () => {
      const db = makeDb({ status: "suspended" });
      const res = await deliver(db, decision("active"));
      assertEquals((await res.json()).outcome, "applied");
      assertEquals(orgStatus(db), "active");
      assertEquals(db.rowsIn("audit_events").find((e) => e.tenant_id)?.event, 'Organization "Hillside Schools" reactivated by Figbloom');
    });

    it("approves a pending organisation, and records a rejection as 'rejected'", async () => {
      const db = makeDb({ status: "pending" });
      await deliver(db, decision("active"));
      assertEquals(orgStatus(db), "active");
      const db2 = makeDb({ status: "pending" });
      await deliver(db2, decision("rejected", {}, { status_reason: "Not a school" }));
      assertEquals(orgStatus(db2), "rejected");
    });

    it("acknowledges a decision it already has without auditing it again", async () => {
      const db = makeDb({ status: "suspended" });
      const res = await deliver(db, decision("suspended"));
      assertEquals([res.status, (await res.json()).outcome], [200, "unchanged"]);
      assertEquals(db.rowsIn("audit_events").length, 0);
    });
  });

  describe("the organisation's schools (20261104910000)", () => {
    const school = (db: FakeSupabaseClient, id: string) => db.rowsIn("tenants").find((t) => t.id === id)!;
    const held = (db: FakeSupabaseClient) => db.rowsIn("organization_suspended_schools").map((h) => h.tenant_id).sort();

    it("suspending the organisation suspends each school, remembering what it was", async () => {
      const db = makeDb();
      await deliver(db, decision("suspended"));
      assertEquals([school(db, PRIMARY).status, school(db, SECONDARY).status], ["suspended", "suspended"]);
      assertEquals([school(db, PRIMARY).status_before_suspension, school(db, SECONDARY).status_before_suspension], ["active", "trial"]);
      assertEquals(held(db), [PRIMARY, SECONDARY].sort());
      const e = db.rowsIn("audit_events").find((x) => x.tenant_id === PRIMARY && x.event.startsWith("School suspended"));
      assertEquals([e?.actor_label, e?.event], ["Figbloom (via Figbloom platform)", 'School suspended with its organization "Hillside Schools": Fees unpaid']);
    });

    it("reactivating it restores only the schools it suspended, each to what it was", async () => {
      const db = makeDb();
      school(db, SECONDARY).status = "suspended"; // suspended on its own before
      await deliver(db, decision("suspended"), { delivery: "1" });
      assertEquals(held(db), [PRIMARY]);
      await deliver(db, decision("active", { decided_at: "2026-11-03T09:59:30.000Z" }), { delivery: "2" });
      assertEquals([school(db, PRIMARY).status, school(db, SECONDARY).status], ["active", "suspended"]);
      assertEquals(held(db), []);
    });

    it("rejected locks the schools the same way, and suspended <-> rejected changes nothing for them", async () => {
      const db = makeDb({ status: "pending" });
      await deliver(db, decision("rejected", {}, { status_reason: "Not a school" }), { delivery: "1" });
      assertEquals(school(db, PRIMARY).status, "suspended");
      await deliver(db, decision("suspended", { decided_at: "2026-11-03T09:59:30.000Z" }), { delivery: "2" });
      assertEquals(held(db), [PRIMARY, SECONDARY].sort());
      assertEquals(school(db, SECONDARY).status_before_suspension, "trial");
    });

    it("a repeated or late decision doesn't touch the schools", async () => {
      const db = makeDb();
      await deliver(db, decision("suspended"), { delivery: "1" });
      await deliver(db, decision("suspended"), { delivery: "1" });
      await deliver(db, decision("active", { decided_at: "2026-11-03T09:00:00.000Z" }), { delivery: "0" });
      assertEquals([school(db, PRIMARY).status, held(db).length], ["suspended", 2]);
    });
  });

  describe("repeats, order and unknowns", () => {
    it("a replayed delivery id is acknowledged and not applied twice", async () => {
      const db = makeDb();
      await deliver(db, decision("suspended"), { delivery: "42" });
      db.rowsIn("organizations")[0].status = "active"; // as if changed since: a replay must not undo it
      const res = await deliver(db, decision("suspended"), { delivery: "42" });
      assertEquals([res.status, (await res.json()).outcome], [200, "duplicate"]);
      assertEquals(orgStatus(db), "active");
      assertEquals(db.rowsIn("audit_events").length, 5); // from the first delivery only: 2 organisation + 2 school + 1 staff
    });

    it("ignores a decision older than the last one applied", async () => {
      const db = makeDb();
      await deliver(db, decision("suspended", { decided_at: "2026-11-03T09:59:00.000Z" }), { delivery: "50" });
      const res = await deliver(db, decision("active", { decided_at: "2026-11-03T09:00:00.000Z" }), { delivery: "49" });
      assertEquals((await res.json()).outcome, "stale");
      assertEquals(orgStatus(db), "suspended");
    });

    it("answers 404 for an organisation Schools doesn't have (so the platform keeps it visible)", async () => {
      const db = makeDb();
      const res = await deliver(db, decision("suspended", {}, { local_id: "99999999-9999-4999-8999-999999999999" }));
      assertEquals(res.status, 404);
      assertEquals(orgStatus(db), "active");
    });

    it("follows only the local id and the status: the platform's own id and anything else are ignored", async () => {
      const db = makeDb();
      const res = await deliver(db, decision("suspended", { redirect: "https://evil.example", tenants: [PRIMARY] }, { id: "another-org", local_id: ORG }));
      assertEquals(res.status, 200);
      assertEquals(orgStatus(db), "suspended");
      assertEquals(db.rowsIn("tenants").map((t) => t.organization_id), [ORG, ORG]);
    });

    it("refuses a body without a usable local id or status", async () => {
      for (const [org, code] of [[{ local_id: "kabarak" }, "invalid_organization"], [{ status: "closed" }, "invalid_status"]] as const) {
        const res = await deliver(makeDb(), decision("suspended", {}, org));
        assertEquals(res.status, 400);
        assertEquals((await res.json()).error.code, code);
      }
    });

    it("acknowledges another event type without acting on it", async () => {
      const db = makeDb();
      const res = await deliver(db, decision("suspended"), { event: "organization.renamed" });
      assertEquals(res.status, 202);
      assertEquals(orgStatus(db), "active");
    });

    it("answers 500 when the database fails, so the platform retries", async () => {
      const db = makeDb();
      db.platformRpcs.platform_apply_organization_decision = () => { throw new Error("deadlock detected"); };
      const res = await deliver(db, decision("suspended"));
      assertEquals(res.status, 500);
      assert(!(await res.text()).includes("deadlock"));
    });
  });

  describe("before switch-on (PLATFORM_DECISIONS_ENABLED off)", () => {
    it("verifies and acknowledges, but doesn't apply; the organisation is flagged for the first reconcile", async () => {
      const db = makeDb({ enabled: false });
      const res = await deliver(db, decision("suspended"));
      assertEquals(res.status, 200);
      assertEquals((await res.json()).applied, false);
      assertEquals(orgStatus(db), "active");
      assertEquals(db.rowsIn("audit_events").length, 0);
      assertEquals(db.rowsIn("platform_organization_decisions")[0].needs_check, true);
    });

    it("still refuses a bad signature", async () => {
      const res = await deliver(makeDb({ enabled: false }), decision("suspended"), { secret: "x".repeat(64) });
      assertEquals(res.status, 401);
    });
  });
});
