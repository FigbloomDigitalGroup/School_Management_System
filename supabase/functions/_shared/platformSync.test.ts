import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { FakeSupabaseClient } from "./fakeSupabase.ts";
import { FakePlatform } from "./fakePlatform.ts";
import { backfill, decisionWebhookUrl, eventWebhookUrl, platformStatusOf, processQueue, reconcile, staffBackfill } from "./platformSync.ts";

const HILLSIDE = "11111111-1111-4111-8111-111111111111";   // an organisation with two schools
const PENDING_ORG = "22222222-2222-4222-8222-222222222222";
const SUSPENDED_ORG = "33333333-3333-4333-8333-333333333333";
const PRIMARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECONDARY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BUNGOMA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";    // no organisation
const KABARAK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";    // no organisation, and its slug is taken by an organisation

function makeDb() {
  const db = new FakeSupabaseClient();
  db.seed("organizations", [
    { id: HILLSIDE, name: "Hillside Schools", slug: "hillside", kind: "group_owner", contact_email: "owner@hillside.test", status: "active", created_at: "2026-09-01T00:00:00Z" },
    { id: PENDING_ORG, name: "New Group", slug: "new-group", kind: "group_owner", contact_email: null, status: "pending", created_at: "2026-10-01T00:00:00Z" },
    { id: SUSPENDED_ORG, name: "Unpaid Group", slug: "kabarak", kind: "group_owner", contact_email: null, status: "suspended", created_at: "2026-10-02T00:00:00Z" },
  ]);
  db.seed("tenants", [
    { id: PRIMARY, name: "Hillside Primary", slug: "hillside-primary", county: "Nairobi", organization_id: HILLSIDE, created_at: "2026-09-02T00:00:00Z" },
    { id: SECONDARY, name: "Hillside Secondary", slug: "hillside-secondary", county: "Nairobi", organization_id: HILLSIDE, created_at: "2026-09-03T00:00:00Z" },
    { id: BUNGOMA, name: "Bungoma High", slug: "bungoma", county: "Bungoma", organization_id: null, created_at: "2026-09-04T00:00:00Z" },
    { id: KABARAK, name: "Kabarak High", slug: "kabarak", county: "Nakuru", organization_id: null, created_at: "2026-09-05T00:00:00Z" },
  ]);
  db.seed("profiles", [
    { id: "p-bungoma-admin", tenant_id: BUNGOMA, role: "school_admin", email: "head@bungoma.test", created_at: "2026-09-04T00:00:00Z" },
    { id: "p-kabarak-admin", tenant_id: KABARAK, role: "school_admin", email: "ad-0001@login.kabarak.figbloom.internal", created_at: "2026-09-05T00:00:00Z" },
  ]);
  return db;
}

const enqueue = (db: FakeSupabaseClient, kind: string, id: string) => db.platformRpcs.platform_sync_enqueue({ p_kind: kind, p_local_id: id });
const pending = (db: FakeSupabaseClient) => db.rowsIn("platform_sync_queue").filter((r) => !r.done_at);

// ---------------------------------------------------------------- the queue
describe("processQueue", () => {
  it("sends organisations before their schools, whatever order they were queued in", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    enqueue(db, "tenant", PRIMARY);
    enqueue(db, "tenant", SECONDARY);
    enqueue(db, "organization", HILLSIDE);
    const report = await processQueue(db, platform.client());
    assertEquals(report.sent, 3);
    assertEquals(platform.calls.map((c) => c.path.split("/")[3]), ["organizations", "tenants", "tenants"]);
    assertEquals(pending(db).length, 0);
    assertEquals(db.rowsIn("platform_links").length, 3);
  });

  it("sends the record as it is now: a rename after queueing goes in the same call", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    enqueue(db, "organization", HILLSIDE);
    db.rowsIn("organizations").find((o) => o.id === HILLSIDE)!.name = "Hillside Group";
    enqueue(db, "organization", HILLSIDE); // the rename's trigger: still one pending row
    assertEquals(pending(db).length, 1);
    await processQueue(db, platform.client());
    assertEquals(platform.organizations.get(HILLSIDE)?.name, "Hillside Group");
    assertEquals(platform.calls.length, 1);
  });

  it("a rename that lands while the old name is on its way is sent next, not lost", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    enqueue(db, "organization", HILLSIDE);
    platform.onCall = () => {
      platform.onCall = null;
      db.rowsIn("organizations").find((o) => o.id === HILLSIDE)!.name = "Hillside Group"; // committed mid-send
      enqueue(db, "organization", HILLSIDE); // its trigger: bumps the pending row's version
    };
    await processQueue(db, platform.client());
    assertEquals(platform.organizations.get(HILLSIDE)?.name, "Hillside Schools");
    assertEquals(pending(db).length, 1, "handed back, not marked done");
    await processQueue(db, platform.client());
    assertEquals(platform.organizations.get(HILLSIDE)?.name, "Hillside Group");
    assertEquals(pending(db).length, 0);
  });

  it("is safe to run twice: a second run finds nothing to send", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    enqueue(db, "organization", HILLSIDE);
    enqueue(db, "tenant", PRIMARY);
    const [a, b] = await Promise.all([processQueue(db, platform.client()), processQueue(db, platform.client())]);
    assertEquals(a.claimed + b.claimed, 2);
    assertEquals(platform.calls.length, 2);
    assertEquals((await processQueue(db, platform.client())).claimed, 0);
  });

  it("a school whose organisation isn't registered queues the organisation and waits a minute", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    let now = Date.parse("2026-11-03T08:00:00Z");
    db.clock = () => now;
    enqueue(db, "tenant", PRIMARY);
    const first = await processQueue(db, platform.client());
    assertEquals(first.failed.map((f) => f.error), ["organization_not_registered"]);
    assert(pending(db).some((r) => r.kind === "organization" && r.local_id === HILLSIDE));
    now += 61_000;
    const second = await processQueue(db, platform.client());
    assertEquals(second.sent, 2);
    assertEquals(platform.tenants.get(PRIMARY)?.organization_local_id, HILLSIDE);
  });

  it("backs off on failures, 1, 2, 4 minutes and on, at most an hour", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    platform.down = 503;
    let now = Date.parse("2026-11-03T08:00:00Z");
    db.clock = () => now;
    enqueue(db, "organization", HILLSIDE);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      await processQueue(db, platform.client());
      const row = pending(db)[0];
      waits.push((Date.parse(row.next_attempt_at) - now) / 60_000);
      now = Date.parse(row.next_attempt_at);
    }
    assertEquals(waits, [1, 2, 4, 8, 16, 32, 60, 60]);
    platform.down = null;
    assertEquals((await processQueue(db, platform.client())).sent, 1);
  });

  it("when the platform can't be reached, hands the rest of the batch back for a minute without trying each", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    platform.down = 0;
    enqueue(db, "organization", HILLSIDE);
    enqueue(db, "organization", PENDING_ORG);
    enqueue(db, "tenant", PRIMARY);
    const report = await processQueue(db, platform.client());
    assertEquals([report.failed.length, report.deferred], [1, 2]);
    assert(pending(db).every((r) => r.last_error));
  });

  it("a school with no organisation waits an hour (it can't be registered without one)", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    enqueue(db, "tenant", BUNGOMA);
    const report = await processQueue(db, platform.client());
    assertEquals(report.failed[0].error, "no_organization");
    assertEquals(platform.calls.length, 0);
  });

  it("a record deleted since it was queued is simply done", async () => {
    const db = makeDb();
    enqueue(db, "organization", "99999999-9999-4999-8999-999999999999");
    const platform = new FakePlatform();
    await processQueue(db, platform.client());
    assertEquals([pending(db).length, platform.calls.length], [0, 0]);
  });

  it("before switch-on, never changes Schools' status from the platform's answer", async () => {
    const db = makeDb();
    const platform = new FakePlatform(); // new organisations start pending there
    enqueue(db, "organization", HILLSIDE);
    await processQueue(db, platform.client());
    assertEquals(db.rowsIn("organizations").find((o) => o.id === HILLSIDE)?.status, "active");
  });

  it("after switch-on, a new organisation takes the platform's decision (pending until approved)", async () => {
    const db = makeDb();
    db.platformDecisionsEnabled = true;
    const platform = new FakePlatform();
    enqueue(db, "organization", HILLSIDE);
    const report = await processQueue(db, platform.client());
    assertEquals(report.adopted, 1);
    assertEquals(db.rowsIn("organizations").find((o) => o.id === HILLSIDE)?.status, "pending");
    // with auto-approve on the platform, it stays active
    const db2 = makeDb();
    db2.platformDecisionsEnabled = true;
    const auto = new FakePlatform();
    auto.autoApprove = true;
    enqueue(db2, "organization", HILLSIDE);
    assertEquals((await processQueue(db2, auto.client())).adopted, 0);
    assertEquals(db2.rowsIn("organizations").find((o) => o.id === HILLSIDE)?.status, "active");
  });
});

// ---------------------------------------------------------------- the backfill
describe("backfill", () => {
  it("dry run: lists what it would do, changes nothing and calls nothing", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    const report = await backfill(db, platform.client(), { dryRun: true });
    assertEquals(report.dry_run, true);
    assertEquals(report.organizations_to_create.map((o) => o.school_name), ["Bungoma High", "Kabarak High"]);
    assertEquals(report.organizations.map((o) => [o.name, o.platform_status]), [
      ["Hillside Schools", "active"], ["New Group", "pending"], ["Unpaid Group", "suspended"],
    ]);
    assertEquals(report.schools.length, 4);
    assertEquals(report.organizations_created, []);
    assertEquals(platform.calls.length + platform.tokensIssued, 0);
    assertEquals(db.rowsIn("organizations").length, 3);
    assertEquals(db.rowsIn("tenants").find((t) => t.id === BUNGOMA)?.organization_id, null);
  });

  it("a dry run needs no platform at all", async () => {
    const report = await backfill(makeDb(), null, { dryRun: true });
    assertEquals(report.organizations_to_create.length, 2);
  });

  it("gives each school without an organisation its own, named after it, then registers everything with today's status", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    const report = await backfill(db, platform.client(), { dryRun: false });
    assertEquals(report.errors, []);

    // Schools' side: two new organisations, one per lone school, the schools moved in
    const bungoma = db.rowsIn("tenants").find((t) => t.id === BUNGOMA)!;
    const bungomaOrg = db.rowsIn("organizations").find((o) => o.id === bungoma.organization_id)!;
    assertEquals([bungomaOrg.name, bungomaOrg.slug, bungomaOrg.kind, bungomaOrg.status, bungomaOrg.contact_email],
      ["Bungoma High", "bungoma", "group_owner", "active", "head@bungoma.test"]);
    const kabarakOrg = db.rowsIn("organizations").find((o) => o.id === db.rowsIn("tenants").find((t) => t.id === KABARAK)!.organization_id)!;
    assertEquals([kabarakOrg.name, kabarakOrg.slug, kabarakOrg.contact_email], ["Kabarak High", "kabarak-school", null]); // slug taken; login-ID address skipped

    // the platform's side: five organisations with their statuses, then four schools under them
    assertEquals(platform.organizations.size, 5);
    assertEquals(platform.organizations.get(HILLSIDE)?.status, "active");
    assertEquals(platform.organizations.get(PENDING_ORG)?.status, "pending");
    assertEquals(platform.organizations.get(SUSPENDED_ORG)?.status, "suspended");
    assertEquals(platform.organizations.get(bungomaOrg.id)?.status, "active");
    assert(platform.calls.filter((c) => c.path.includes("/organizations/")).every((c) => (c.body as { backfill?: boolean }).backfill === true));
    assertEquals(platform.tenants.size, 4);
    assertEquals(platform.tenants.get(BUNGOMA)?.organization_local_id, bungomaOrg.id);
    const firstTenant = platform.calls.findIndex((c) => c.path.includes("/tenants/"));
    assert(platform.calls.slice(firstTenant).every((c) => c.path.includes("/tenants/")), "organisations first, then schools");

    // and nothing is left for the queue to send again
    assertEquals(pending(db).length, 0);
  });

  it("keeps a status staff already decided on the platform, and still sends the name", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    await backfill(db, platform.client(), { dryRun: false });
    platform.decide(PENDING_ORG, "rejected", "Not a school");
    db.rowsIn("organizations").find((o) => o.id === PENDING_ORG)!.name = "New Group Ltd";
    const report = await backfill(db, platform.client(), { dryRun: false });
    assertEquals(report.organizations.find((o) => o.id === PENDING_ORG)?.result, "decided_on_platform");
    assertEquals(platform.organizations.get(PENDING_ORG)?.status, "rejected");
    assertEquals(platform.organizations.get(PENDING_ORG)?.name, "New Group Ltd");
    assertEquals(report.organizations_to_create, []); // the lone schools got theirs the first time
  });

  it("clears what was queued, but a rename during the backfill is still sent afterwards", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    enqueue(db, "tenant", PRIMARY);
    enqueue(db, "organization", HILLSIDE);
    platform.onCall = (_m, path) => {
      if (path.endsWith(`/tenants/${PRIMARY}`)) {
        platform.onCall = null;
        db.rowsIn("tenants").find((t) => t.id === PRIMARY)!.name = "Hillside Junior";
        enqueue(db, "tenant", PRIMARY);
      }
    };
    await backfill(db, platform.client(), { dryRun: false });
    assertEquals(pending(db).map((r) => [r.kind, r.local_id]), [["tenant", PRIMARY]]);
    await processQueue(db, platform.client());
    assertEquals(platform.tenants.get(PRIMARY)?.name, "Hillside Junior");
  });

  it("reports a failed record and carries on with the rest", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    db.rowsIn("tenants").find((t) => t.id === SECONDARY)!.organization_id = "99999999-9999-4999-8999-999999999999";
    const report = await backfill(db, platform.client(), { dryRun: false });
    assertEquals(report.errors.map((e) => [e.kind, e.id]), [["school", SECONDARY]]);
    assertEquals(platform.tenants.size, 3);
  });
});

// ---------------------------------------------------------------- the reconcile
describe("reconcile", () => {
  async function registered() {
    const db = makeDb();
    const platform = new FakePlatform();
    await backfill(db, platform.client(), { dryRun: false });
    db.platformDecisionsEnabled = true;
    return { db, platform };
  }

  it("does nothing before switch-on", async () => {
    const db = makeDb();
    const platform = new FakePlatform();
    assertEquals((await reconcile(db, platform.client())).skipped, "not_enabled");
    assertEquals(platform.calls.length, 0);
  });

  it("applies a decision it missed, through the same decision function, and logs it", async () => {
    const { db, platform } = await registered();
    platform.decide(HILLSIDE, "suspended", "Fees unpaid");
    const report = await reconcile(db, platform.client());
    assertEquals(report.fixed, [{ organization_id: HILLSIDE, from: "active", to: "suspended" }]);
    assertEquals(db.rowsIn("organizations").find((o) => o.id === HILLSIDE)?.status, "suspended");
    const audit = db.rowsIn("audit_events").filter((e) => e.metadata?.organization_id === HILLSIDE);
    assertEquals(audit.filter((e) => e.tenant_id && e.event.startsWith("Organization")).length, 2); // one per school
    // and since 20261104910000 its schools are suspended with it
    assertEquals(db.rowsIn("tenants").filter((t) => t.organization_id === HILLSIDE).map((t) => t.status), ["suspended", "suspended"]);
    assertEquals(audit.find((e) => !e.tenant_id)?.metadata.decided_by, "platform:reconcile");
  });

  it("marks matching organisations checked, and checks flagged ones first", async () => {
    const { db, platform } = await registered();
    db.platformRpcs.platform_note_unapplied_delivery({ p_delivery_id: "7", p_organization_id: SUSPENDED_ORG });
    const report = await reconcile(db, platform.client(), { limit: 1 });
    assertEquals(report.checked, 1);
    assertEquals(platform.calls.at(-1)?.path, `/products/schools/organizations/${SUSPENDED_ORG}`);
    assertEquals(db.rowsIn("platform_organization_decisions").find((d) => d.organization_id === SUSPENDED_ORG)?.needs_check, false);
  });

  it("queues an organisation the platform doesn't know", async () => {
    const { db, platform } = await registered();
    platform.organizations.delete(HILLSIDE);
    const report = await reconcile(db, platform.client());
    assertEquals(report.not_registered, [HILLSIDE]);
    assert(pending(db).some((r) => r.kind === "organization" && r.local_id === HILLSIDE));
  });

  it("stops when the platform can't be reached, changing nothing", async () => {
    const { db, platform } = await registered();
    platform.down = 0;
    const report = await reconcile(db, platform.client());
    assertEquals([report.checked, report.errors.length, report.fixed.length], [0, 1, 0]);
  });
});

describe("helpers", () => {
  it("maps Schools' statuses to the platform's four", () => {
    assertEquals(["active", "pending", "suspended", "rejected", "odd"].map(platformStatusOf), ["active", "pending", "suspended", "rejected", "pending"]);
  });
  it("the webhook address: given, PLATFORM_WEBHOOK_URL, or this project's platform-decisions; https only", () => {
    const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
    assertEquals(decisionWebhookUrl(env({ SUPABASE_URL: "https://abc.supabase.co/" })), "https://abc.supabase.co/functions/v1/platform-decisions");
    assertEquals(decisionWebhookUrl(env({ PLATFORM_WEBHOOK_URL: "https://schools.example/hook", SUPABASE_URL: "https://abc.supabase.co" })), "https://schools.example/hook");
    assertEquals(decisionWebhookUrl(env({}), "https://given.example/x"), "https://given.example/x");
    assertEquals(decisionWebhookUrl(env({ SUPABASE_URL: "http://kong:8000" })), null);
    assertEquals(decisionWebhookUrl(env({})), null);
  });
});

// ---------------------------------------------------------------- staff events (20261105600000)
describe("staff events", () => {
  const TEACHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
  const DRIVER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";

  function staffDb() {
    const db = makeDb();
    db.seed("profiles", [
      { id: TEACHER, tenant_id: PRIMARY, role: "teacher", full_name: "Jane Wanjiru", phone: "+254711000001", staff_title: null,
        email: "tc-0001@login.hillside-primary.figbloom.internal", auth_email: "tc-0001@login.hillside-primary.figbloom.internal", archived_at: null },
      { id: DRIVER, tenant_id: PRIMARY, role: "driver", full_name: "Sam Kiptoo", phone: null, staff_title: "Bus driver",
        email: "Sam@Hillside.ac.ke", archived_at: null },
    ]);
    db.platformStaffEventsEnabled = true;                                    // PLATFORM_STAFF_EVENTS_ENABLED on
    db.platformRpcs.platform_record_link({ p_kind: "tenant", p_local_id: PRIMARY, p_platform_id: "pt-1" });   // registered
    return db;
  }
  /** The school registered already, as it is on staging. */
  function platformWithSchool() {
    const platform = new FakePlatform();
    platform.tenants.set(PRIMARY, { tenant_id: "pt-1", name: "Hillside Primary", local_slug: "hillside-primary", organization_local_id: HILLSIDE });
    return platform;
  }
  const staffEnqueue = (db: FakeSupabaseClient, id: string, event: string, leftOn: string | null = null) =>
    db.platformRpcs.platform_staff_enqueue({ p_profile_id: id, p_event: event, p_tenant_id: PRIMARY, p_left_on: leftOn });

  it("sends a staff row as POST /events: the type, the row's event id, the school as tenant_local_id, the person as now", async () => {
    const db = staffDb();
    const platform = platformWithSchool();
    staffEnqueue(db, DRIVER, "created");
    const eventId = pending(db)[0].event_id;
    const report = await processQueue(db, platform.client());
    assertEquals([report.sent, report.events, report.failed.length], [1, 1, 0]);
    assertEquals(platform.calls.map((c) => `${c.method} ${c.path}`), ["POST /events"]);
    const e = platform.events[0];
    assertEquals([e.type, e.id, e.tenant_local_id], ["schools.staff.created", eventId, PRIMARY]);
    assert(!Number.isNaN(Date.parse(e.occurred_at)));
    assertEquals(e.data, { person_id: DRIVER, full_name: "Sam Kiptoo", phone: null, email: "sam@hillside.ac.ke", role: "driver", job_title: "Bus driver" });
    assertEquals(pending(db).length, 0);
    assertEquals(db.rowsIn("platform_links").map((l) => l.kind), ["tenant"], "a staff event registers nothing (only the school's own link)");
  });

  it("a synthetic login address is sent as email null; no title: the role's name", async () => {
    const db = staffDb();
    const platform = platformWithSchool();
    staffEnqueue(db, TEACHER, "created");
    await processQueue(db, platform.client());
    assertEquals(platform.events[0].data.email, null);
    assertEquals(platform.events[0].data.job_title, "Teacher");
  });

  it("left carries only person_id and left_on", async () => {
    const db = staffDb();
    const platform = platformWithSchool();
    staffEnqueue(db, TEACHER, "left", "2026-11-30");
    await processQueue(db, platform.client());
    assertEquals(platform.events.map((e) => [e.type, e.data]), [["schools.staff.left", { person_id: TEACHER, left_on: "2026-11-30" }]]);
  });

  it("goes after organisations and schools in the same batch", async () => {
    const db = staffDb();
    const platform = new FakePlatform();
    staffEnqueue(db, DRIVER, "created");
    enqueue(db, "tenant", PRIMARY);
    enqueue(db, "organization", HILLSIDE);
    const report = await processQueue(db, platform.client());
    assertEquals(report.sent, 3);
    assertEquals(platform.calls.map((c) => c.path === "/events" ? "events" : c.path.split("/")[3]), ["organizations", "tenants", "events"]);
  });

  it("a change while on its way goes again, as an update with a new event id, never swallowed as a repeat", async () => {
    const db = staffDb();
    const platform = platformWithSchool();
    staffEnqueue(db, DRIVER, "created");
    platform.onCall = () => {
      platform.onCall = null;
      db.rowsIn("profiles").find((p) => p.id === DRIVER)!.full_name = "Samuel Kiptoo";
      staffEnqueue(db, DRIVER, "updated");   // the rename's trigger
    };
    await processQueue(db, platform.client());
    assertEquals(pending(db).map((r) => r.event), ["updated"]);
    await processQueue(db, platform.client());
    assertEquals(platform.events.map((e) => e.type), ["schools.staff.created", "schools.staff.updated"]);
    assert(platform.events[0].id !== platform.events[1].id);
    assertEquals(platform.events[1].data.full_name, "Samuel Kiptoo");
  });

  it("a 404 from the platform (the school isn't linked there) ends the row as skipped_unlinked, not retried", async () => {
    const db = staffDb();
    const platform = new FakePlatform();   // doesn't know PRIMARY
    staffEnqueue(db, DRIVER, "created");
    const report = await processQueue(db, platform.client());
    assertEquals([report.sent, report.failed.length], [0, 0]);
    assertEquals(report.skipped, [{ local_id: DRIVER, tenant_local_id: PRIMARY, reason: "skipped_unlinked" }]);
    assertEquals(pending(db).length, 0);
    const row = db.rowsIn("platform_sync_queue").find((r) => r.local_id === DRIVER)!;
    assertEquals([Boolean(row.done_at), row.skipped], [true, "skipped_unlinked"]);
    assertEquals((await processQueue(db, platform.client())).claimed, 0, "never tried again");
  });

  it("other refusals still retry with the queue's backoff", async () => {
    const db = staffDb();
    const platform = platformWithSchool();
    platform.down = 503;
    let now = Date.parse("2026-11-05T08:00:00Z");
    db.clock = () => now;
    staffEnqueue(db, DRIVER, "created");
    assertEquals((await processQueue(db, platform.client())).failed.length, 1);
    assertEquals((Date.parse(pending(db)[0].next_attempt_at) - now) / 60_000, 1);
    platform.down = null;
    now += 61_000;
    assertEquals((await processQueue(db, platform.client())).events, 1);
  });

  it("nothing is queued while sending is switched off (PLATFORM_STAFF_EVENTS_ENABLED), or for a school the platform doesn't know", () => {
    const db = staffDb();
    db.platformStaffEventsEnabled = false;
    staffEnqueue(db, DRIVER, "created");
    assertEquals(pending(db).length, 0);
    db.platformStaffEventsEnabled = true;
    db.platformRpcs.platform_staff_enqueue({ p_profile_id: DRIVER, p_event: "created", p_tenant_id: SECONDARY, p_left_on: null });
    assertEquals(pending(db).length, 0, "SECONDARY isn't registered");
  });

  it("a person no longer current (archived by HR, so not echoed) is not sent as an update", async () => {
    const db = staffDb();
    const platform = platformWithSchool();
    staffEnqueue(db, DRIVER, "updated");
    db.rowsIn("profiles").find((p) => p.id === DRIVER)!.archived_at = "2026-11-05T07:00:00Z";
    const report = await processQueue(db, platform.client());
    assertEquals([report.sent, platform.calls.length, pending(db).length], [0, 0, 0]);
  });

  it("merging while pending: left wins, a pending created stays created, a restore after left is created", () => {
    const db = staffDb();
    staffEnqueue(db, DRIVER, "created");
    const firstId = pending(db)[0].event_id;
    staffEnqueue(db, DRIVER, "updated");
    assertEquals(pending(db).map((r) => [r.event, r.version]), [["created", 2]]);
    assert(pending(db)[0].event_id !== firstId, "new content, new event id");
    staffEnqueue(db, DRIVER, "left", "2026-11-30");
    assertEquals(pending(db).map((r) => [r.event, r.left_on]), [["left", "2026-11-30"]]);
    staffEnqueue(db, DRIVER, "created");
    assertEquals(pending(db).map((r) => [r.event, r.left_on]), [["created", null]]);
  });
});

describe("staffBackfill", () => {
  it("a dry run lists the school's current staff and queues nothing; for real, queues created for each", async () => {
    const db = makeDb();
    db.seed("profiles", [
      { id: "s-1", tenant_id: PRIMARY, role: "teacher", full_name: "A Teacher", archived_at: null },
      { id: "s-2", tenant_id: PRIMARY, role: "school_admin", full_name: "A Head", email: "head@hillside.ac.ke", archived_at: null },
      { id: "s-3", tenant_id: PRIMARY, role: "teacher", full_name: "Archived Teacher", archived_at: "2026-10-01T00:00:00Z" },
      { id: "s-4", tenant_id: PRIMARY, role: "parent", full_name: "A Parent", archived_at: null },
      { id: "s-5", tenant_id: SECONDARY, role: "teacher", full_name: "Other School", archived_at: null },
    ]);
    db.platformStaffEventsEnabled = true;
    db.platformRpcs.platform_record_link({ p_kind: "tenant", p_local_id: PRIMARY, p_platform_id: "pt-1" });
    const dry = await staffBackfill(db, { schoolId: PRIMARY });
    assertEquals([dry.dry_run, dry.count, dry.staff.map((s) => s.person_id)], [true, 2, ["s-1", "s-2"]]);
    assertEquals(pending(db).length, 0);
    const real = await staffBackfill(db, { schoolId: PRIMARY, dryRun: false });
    assertEquals([real.queued, pending(db).map((r) => [r.kind, r.local_id, r.event])], [2, [["staff", "s-1", "created"], ["staff", "s-2", "created"]]]);
  });

  it("for real is refused while sending is off, or for a school the platform doesn't know; the dry run still lists", async () => {
    const db = makeDb();
    db.seed("profiles", [{ id: "s-1", tenant_id: PRIMARY, role: "teacher", full_name: "A Teacher", archived_at: null }]);
    const dry = await staffBackfill(db, { schoolId: PRIMARY });
    assertEquals([dry.count, dry.sending_enabled, dry.school_linked], [1, false, false]);
    await assertRejects(() => staffBackfill(db, { schoolId: PRIMARY, dryRun: false }), Error, "staff_events_disabled");
    db.platformStaffEventsEnabled = true;
    await assertRejects(() => staffBackfill(db, { schoolId: PRIMARY, dryRun: false }), Error, "school_not_linked");
    assertEquals(pending(db).length, 0);
  });
});

describe("eventWebhookUrl", () => {
  it("given, PLATFORM_EVENTS_URL, or this project's platform-events; https only", () => {
    const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
    assertEquals(eventWebhookUrl(env({ SUPABASE_URL: "https://abc.supabase.co/" })), "https://abc.supabase.co/functions/v1/platform-events");
    assertEquals(eventWebhookUrl(env({ PLATFORM_EVENTS_URL: "https://schools.example/events", SUPABASE_URL: "https://abc.supabase.co" })), "https://schools.example/events");
    assertEquals(eventWebhookUrl(env({}), "https://given.example/x"), "https://given.example/x");
    assertEquals(eventWebhookUrl(env({ PLATFORM_EVENTS_URL: "http://insecure.example/x" })), null);
  });
});
