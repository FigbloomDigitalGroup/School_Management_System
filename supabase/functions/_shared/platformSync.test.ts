import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "./fakeSupabase.ts";
import { FakePlatform } from "./fakePlatform.ts";
import { backfill, decisionWebhookUrl, platformStatusOf, processQueue, reconcile } from "./platformSync.ts";

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
