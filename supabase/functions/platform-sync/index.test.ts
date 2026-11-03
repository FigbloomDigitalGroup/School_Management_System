import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { FakePlatform } from "../_shared/fakePlatform.ts";
import { handle } from "./index.ts";

/** The legacy service_role key the runtime injected (SUPABASE_SERVICE_ROLE_KEY). */
const KEY = "service-role-key-for-tests";
const SYNC_KEY = "s".repeat(40);
const SECRET_KEY = "sb_secret_abcdefghijklmnopqrstuvwxyz012345";
const ORG = "11111111-1111-4111-8111-111111111111";
const LONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function setup({ configured = true, vars = {} as Record<string, string> } = {}) {
  const db = new FakeSupabaseClient();
  db.seed("organizations", [{ id: ORG, name: "Hillside", slug: "hillside", status: "active", created_at: "2026-09-01T00:00:00Z" }]);
  db.seed("tenants", [{ id: LONE, name: "Bungoma High", slug: "bungoma", county: "Bungoma", organization_id: null, created_at: "2026-09-02T00:00:00Z" }]);
  const platform = new FakePlatform();
  const all: Record<string, string> = {
    SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }), PLATFORM_SYNC_KEY: SYNC_KEY, ...vars,
  };
  const env = { get: (k: string) => all[k] || undefined };
  const send = (body: unknown, headers: Record<string, string>) => handle(
    new Request("https://abc.supabase.co/functions/v1/platform-sync", { method: "POST", body: JSON.stringify(body), headers }),
    { admin: db, client: configured ? platform.client() : null, env },
  );
  const call = (body: unknown, key: string | null = SYNC_KEY) => send(body, key === null ? {} : { authorization: `Bearer ${key}` });
  return { db, platform, call, send };
}

describe("platform-sync", () => {
  describe("who may call it", () => {
    it("accepts PLATFORM_SYNC_KEY as a bearer token or in x-platform-sync-key", async () => {
      const { call, send } = setup();
      assertEquals((await call({ action: "backfill" }, SYNC_KEY)).status, 200);
      assertEquals((await send({ action: "backfill" }, { "x-platform-sync-key": SYNC_KEY })).status, 200);
    });

    it("still accepts the injected legacy service-role key, and the new sb_secret_ keys, as bearer or apikey", async () => {
      const { call, send } = setup();
      assertEquals((await call({ action: "backfill" }, KEY)).status, 200);
      assertEquals((await call({ action: "backfill" }, SECRET_KEY)).status, 200);
      assertEquals((await send({ action: "backfill" }, { apikey: SECRET_KEY })).status, 200);
    });

    it("refuses no key, a wrong one, an anon key, or one that only starts like a right one", async () => {
      const { call, send, platform } = setup();
      assertEquals((await call({ action: "sync" }, null)).status, 401);
      assertEquals((await call({ action: "sync" }, "anon-key")).status, 401);
      assertEquals((await call({ action: "sync" }, `${KEY}x`)).status, 401);
      assertEquals((await call({ action: "sync" }, SYNC_KEY.slice(0, 39))).status, 401);
      assertEquals((await send({ action: "sync" }, { "x-platform-sync-key": "nope" })).status, 401);
      assertEquals(platform.calls.length, 0);
    });

    it("works with only PLATFORM_SYNC_KEY (the injected key isn't the dashboard's)", async () => {
      const { call } = setup({ vars: { SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: "" } });
      assertEquals((await call({ action: "backfill" }, SYNC_KEY)).status, 200);
      assertEquals((await call({ action: "backfill" }, KEY)).status, 401);
    });

    it("ignores a PLATFORM_SYNC_KEY shorter than 32 characters", async () => {
      const short = "short-key";
      const { call } = setup({ vars: { PLATFORM_SYNC_KEY: short } });
      assertEquals((await call({ action: "backfill" }, short)).status, 401);
      assertEquals((await call({ action: "backfill" }, KEY)).status, 200);
    });

    it("survives a SUPABASE_SECRET_KEYS that isn't JSON", async () => {
      const { call } = setup({ vars: { SUPABASE_SECRET_KEYS: "not json" } });
      assertEquals((await call({ action: "backfill" }, SYNC_KEY)).status, 200);
    });
  });

  it("sync sends the queue", async () => {
    const { db, call, platform } = setup();
    db.platformRpcs.platform_sync_enqueue({ p_kind: "organization", p_local_id: ORG });
    const res = await call({ action: "sync" });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).sent, 1);
    assertEquals(platform.organizations.has(ORG), true);
  });

  it("backfill is a dry run unless dry_run is false", async () => {
    const { db, call, platform } = setup();
    const dry = await (await call({ action: "backfill" })).json();
    assertEquals([dry.dry_run, dry.organizations_to_create.length, platform.calls.length], [true, 1, 0]);
    assertEquals(db.rowsIn("organizations").length, 1);
    const real = await (await call({ action: "backfill", dry_run: false })).json();
    assertEquals([real.dry_run, real.organizations_created.length, real.errors.length], [false, 1, 0]);
    assertEquals(platform.tenants.has(LONE), true);
  });

  it("a dry run works before the platform secrets are set; everything else says they're missing", async () => {
    const { call } = setup({ configured: false });
    assertEquals((await call({ action: "backfill" })).status, 200);
    for (const body of [{ action: "sync" }, { action: "reconcile" }, { action: "backfill", dry_run: false }, { action: "register_webhook" }]) {
      const res = await call(body);
      assertEquals(res.status, 503);
      assertEquals((await res.json()).error.code, "platform_not_configured");
    }
  });

  it("register_webhook gives the platform this project's platform-decisions address, or the one given", async () => {
    const { call, platform } = setup();
    assertEquals((await (await call({ action: "register_webhook" })).json()).url, "https://abc.supabase.co/functions/v1/platform-decisions");
    assertEquals(platform.webhookUrl, "https://abc.supabase.co/functions/v1/platform-decisions");
    await call({ action: "register_webhook", url: "https://schools.example/platform/decisions" });
    assertEquals(platform.webhookUrl, "https://schools.example/platform/decisions");
    assertEquals((await call({ action: "register_webhook", url: "http://insecure.example/x" })).status, 400);
  });

  it("reconcile does nothing before switch-on", async () => {
    const { call } = setup();
    assertEquals((await (await call({ action: "reconcile" })).json()).skipped, "not_enabled");
  });

  it("refuses an unknown action, and answers 502 when the platform refuses", async () => {
    const { call, platform } = setup();
    assertEquals((await call({ action: "delete_everything" })).status, 400);
    platform.down = 400;
    assertEquals((await call({ action: "register_webhook" })).status, 502);
  });
});
