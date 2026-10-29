import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

/**
 * QA 08 (FIG-1241): who may ask bus-tick to push "your child's bus is arriving" to a trip's families. The ETA and push logic is
 * tested in plan.test.ts; this file had no tests for the function's caller checks, which are all that stands between a signed-in
 * user and a push to every family on a route. A trip that is not running answers { skipped } after the checks, so none of
 * these reach the push code.
 */

const SERVICE_KEY = "service-role-key";
const TRIP_ID = "trip-1";
const DRIVER = "driver-1";

function clients(opts: { caller?: string | null; trip?: Record<string, unknown> | null } = {}) {
  const admin = new FakeSupabaseClient();
  const asUser = new FakeSupabaseClient();
  asUser.authUser = opts.caller === null ? null : { id: opts.caller ?? DRIVER };
  admin.seed("trips", opts.trip === null ? [] : [{ id: TRIP_ID, tenant_id: "tenant-1", driver_id: DRIVER, status: "completed", route_id: null, ...opts.trip }]);
  return { admin, asUser };
}

const deps = (c: { admin: FakeSupabaseClient; asUser: FakeSupabaseClient }) => ({ admin: c.admin, asUser: c.asUser, serviceKey: SERVICE_KEY, googleKey: null });

function request(body: unknown = { trip_id: TRIP_ID }, opts: { method?: string; auth?: string | null } = {}) {
  const method = opts.method ?? "POST";
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer user-token");
  return new Request("https://example.com/bus-tick", { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) });
}

describe("bus-tick: who may ask for a tick", () => {
  it("answers a CORS preflight and refuses anything but POST", async () => {
    assertEquals((await handle(request(undefined, { method: "OPTIONS", auth: null }), deps(clients()))).status, 200);
    assertEquals((await handle(request(undefined, { method: "GET" }), deps(clients()))).status, 405);
  });

  it("refuses a request with no Authorization header", async () => {
    assertEquals((await handle(request(undefined, { auth: null }), deps(clients()))).status, 401);
  });

  it("refuses a token that does not resolve to a user", async () => {
    assertEquals((await handle(request(), deps(clients({ caller: null })))).status, 401);
  });

  it("asks for a trip, and says when there is no such trip", async () => {
    assertEquals((await handle(request({}), deps(clients()))).status, 400);
    assertEquals((await handle(request({ trip_id: "nope" }), deps(clients({ trip: null })))).status, 404);
  });

  for (const [who, caller] of [["another driver", "driver-2"], ["a parent", "parent-1"], ["a teacher", "teacher-1"], ["a school admin", "admin-1"]]) {
    it(`refuses ${who} (only the trip's own driver may tick it)`, async () => {
      const res = await handle(request(), deps(clients({ caller })));
      assertEquals(res.status, 403);
      assertEquals((await res.json()).error, "Not your trip");
    });
  }

  it("lets the trip's own driver through the checks", async () => {
    const res = await handle(request(), deps(clients({ caller: DRIVER })));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).skipped, "trip not running on a route");
  });

  it("lets the service role key tick any trip (the trip simulator), without asking who it is", async () => {
    const c = clients({ caller: null }); // getUser() would say "nobody": the service key must not need it
    const res = await handle(request({ trip_id: TRIP_ID }, { auth: `Bearer ${SERVICE_KEY}` }), deps(c));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).skipped, "trip not running on a route");
  });

  it("does not treat a token that merely starts like the service key as the service key", async () => {
    const c = clients({ caller: null });
    assertEquals((await handle(request(undefined, { auth: `Bearer ${SERVICE_KEY}x` }), deps(c))).status, 401);
    assertEquals((await handle(request(undefined, { auth: `Bearer ${SERVICE_KEY.slice(0, -1)}` }), deps(c))).status, 401);
  });
});
