import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { signFigbloomWebhook } from "../_shared/platformWebhook.ts";
import { handle } from "./index.ts";

const SECRET = "w".repeat(64);
const NOW = Date.parse("2026-11-05T10:00:00Z");
const SCHOOL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SCHOOL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";

function makeDb({ enabled = true } = {}) {
  const db = new FakeSupabaseClient();
  db.platformEventsEnabled = enabled;
  db.seed("tenants", [{ id: SCHOOL, name: "Hillside Primary" }, { id: OTHER_SCHOOL, name: "Bungoma High" }]);
  db.seed("profiles", [
    { id: TEACHER, tenant_id: SCHOOL, role: "teacher", full_name: "Jane Wanjiru", archived_at: null },
    { id: PARENT, tenant_id: SCHOOL, role: "parent", full_name: "Peter Otieno", archived_at: null },
  ]);
  return db;
}

function left(data: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: {
      type: "hr.employee.left", id: "01JC0000000000000000000000", occurred_at: "2026-11-05T09:59:00Z", source: "hr",
      platform_tenant_id: "99999999-9999-4999-8999-999999999999", tenant_local_id: SCHOOL,
      data: { employee_number: "EMP-0007", external_id: TEACHER, left_on: "2026-11-30", ...data },
      ...event,
    },
    delivered_at: "2026-11-05T10:00:00Z",
  });
}

async function deliver(db: FakeSupabaseClient, body: string, opts: { delivery?: string; at?: number; secret?: string; signature?: string; timestamp?: string; event?: string } = {}) {
  const signed = await signFigbloomWebhook(opts.secret ?? SECRET, body, opts.at ?? NOW);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-figbloom-event": opts.event ?? "hr.employee.left",
    "x-figbloom-delivery": opts.delivery ?? "d-1",
    "x-figbloom-timestamp": opts.timestamp ?? signed.timestamp,
    "x-figbloom-signature": opts.signature ?? signed.signature,
  };
  return handle(new Request("https://schools.test/functions/v1/platform-events", { method: "POST", headers, body }), { admin: db, secret: SECRET, now: () => NOW });
}

const teacher = (db: FakeSupabaseClient) => db.rowsIn("profiles").find((p) => p.id === TEACHER)!;

describe("platform-events", () => {
  describe("verification", () => {
    it("refuses a wrong signature and changes nothing", async () => {
      const db = makeDb();
      const res = await deliver(db, left(), { secret: "x".repeat(64) });
      assertEquals(res.status, 401);
      assertEquals(teacher(db).archived_at, null);
      assertEquals(db.rowsIn("platform_event_deliveries").length, 0);
    });

    it("refuses a body changed after signing (another person swapped in)", async () => {
      const db = makeDb();
      const signed = await signFigbloomWebhook(SECRET, left({ external_id: PARENT }), NOW);
      const res = await deliver(db, left(), { signature: signed.signature, timestamp: signed.timestamp });
      assertEquals(res.status, 401);
      assertEquals(teacher(db).archived_at, null);
    });

    it("refuses a stale timestamp", async () => {
      const db = makeDb();
      assertEquals((await deliver(db, left(), { at: NOW - 6 * 60_000 })).status, 401);
      assertEquals(teacher(db).archived_at, null);
    });

    it("refuses everything when PLATFORM_WEBHOOK_SECRET isn't set, and anything but POST", async () => {
      const db = makeDb();
      const body = left();
      const signed = await signFigbloomWebhook(SECRET, body, NOW);
      const res = await handle(new Request("https://s.test/f", {
        method: "POST", body,
        headers: { "x-figbloom-delivery": "1", "x-figbloom-signature": signed.signature, "x-figbloom-timestamp": signed.timestamp },
      }), { admin: db, secret: undefined, now: () => NOW });
      assertEquals(res.status, 401);
      assertEquals((await handle(new Request("https://s.test/f"), { admin: db, secret: SECRET, now: () => NOW })).status, 405);
      assertEquals(teacher(db).archived_at, null);
    });
  });

  describe("hr.employee.left", () => {
    it("archives the person, with HR's date, logged once", async () => {
      const db = makeDb();
      const res = await deliver(db, left());
      assertEquals(res.status, 200);
      assertEquals((await res.json()).applied, true);
      assert(teacher(db).archived_at);
      assertEquals(teacher(db).left_on, "2026-11-30");
      assertEquals(db.rowsIn("platform_event_deliveries").map((d) => [d.delivery_id, d.outcome]), [["d-1", "archived"]]);
      const audit = db.rowsIn("audit_events");
      assertEquals(audit.length, 1);
      assertEquals(audit[0].tenant_id, SCHOOL);
      assertEquals(audit[0].metadata.employee_number, "EMP-0007");
    });

    it("a repeated delivery is acknowledged and not applied again", async () => {
      const db = makeDb();
      await deliver(db, left());
      const res = await deliver(db, left());
      assertEquals(res.status, 200);
      assertEquals((await res.json()).outcome, "duplicate");
      assertEquals(db.rowsIn("audit_events").length, 1);
    });

    it("refuses a person of another school (the delivery's school must be theirs), and changes nothing", async () => {
      const db = makeDb();
      const res = await deliver(db, left({}, { tenant_local_id: OTHER_SCHOOL }));
      assertEquals(res.status, 403);
      assertEquals((await res.json()).error.code, "tenant_mismatch");
      assertEquals(teacher(db).archived_at, null);
      assertEquals(db.rowsIn("audit_events").length, 0);
      assertEquals(db.rowsIn("platform_event_deliveries").length, 0, "not recorded: a re-drive is looked at afresh");
    });

    it("refuses a person Schools doesn't have (404) and one who isn't staff (409)", async () => {
      const db = makeDb();
      assertEquals((await deliver(db, left({ external_id: "33333333-3333-4333-8333-333333333333" }))).status, 404);
      assertEquals((await deliver(db, left({ external_id: PARENT }), { delivery: "d-2" })).status, 409);
      assertEquals(db.rowsIn("profiles").filter((p) => p.archived_at).length, 0);
    });

    it("refuses a malformed event: no school, no person, a bad date, no delivery id", async () => {
      const db = makeDb();
      assertEquals((await deliver(db, left({}, { tenant_local_id: null }))).status, 400);
      assertEquals((await deliver(db, left({ external_id: "TC-0001" }))).status, 400);
      assertEquals((await deliver(db, left({ left_on: "30/11/2026" }))).status, 400);
      assertEquals((await deliver(db, left(), { delivery: "" })).status, 400);
      assertEquals((await deliver(db, left(), { event: "hr.employee.created" })).status, 400, "header and body disagree");
      assertEquals(teacher(db).archived_at, null);
    });

    it("someone already archived: acknowledged", async () => {
      const db = makeDb();
      teacher(db).archived_at = "2026-11-01T00:00:00Z";
      const res = await deliver(db, left());
      assertEquals(res.status, 200);
      assertEquals((await res.json()).outcome, "already_archived");
    });
  });

  describe("switched off (PLATFORM_EVENTS_ENABLED)", () => {
    it("verifies, records and acknowledges, but does not archive", async () => {
      const db = makeDb({ enabled: false });
      const res = await deliver(db, left());
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, applied: false, reason: "events_not_enabled" });
      assertEquals(teacher(db).archived_at, null);
      assertEquals(db.rowsIn("audit_events").length, 0);
      assertEquals(db.rowsIn("platform_event_deliveries").map((d) => [d.delivery_id, d.outcome]), [["d-1", "not_enabled"]]);
    });

    it("still refuses a bad signature", async () => {
      const db = makeDb({ enabled: false });
      assertEquals((await deliver(db, left(), { secret: "y".repeat(64) })).status, 401);
      assertEquals(db.rowsIn("platform_event_deliveries").length, 0);
    });
  });

  it("a signed event of another type is acknowledged and ignored", async () => {
    const db = makeDb();
    const res = await deliver(db, left({}, { type: "hr.employee.created" }), { event: "hr.employee.created" });
    assertEquals(res.status, 202);
    assertEquals(teacher(db).archived_at, null);
  });

  it("a database failure is a 500, so the platform retries", async () => {
    const db = makeDb();
    const original = db.platformRpcs.platform_staff_left;
    db.platformRpcs.platform_staff_left = () => { throw new Error("connection reset"); };
    const res = await deliver(db, left());
    assertEquals(res.status, 500);
    db.platformRpcs.platform_staff_left = original;
    assertEquals((await deliver(db, left())).status, 200, "the retry applies it");
    assert(teacher(db).archived_at);
  });
});
