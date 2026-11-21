import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

/**
 * FIG-770: on an emulator with no mock GPS, a brand-new trip's first tick answered `updates: 0` and no "Bus has left school"
 * reached the feed. plan.test.ts proves the planning is right; index.test.ts only reaches the early `skipped` exits. These
 * run the whole handler (fetch the trip, work out the plan, insert, answer) against the fake database, with the emulator's
 * position (California, 14,900 km from a Nairobi route) and an ordinary on-route start.
 */

const TRIP_ID = "trip-1";
const DRIVER = "driver-1";
const NOW = new Date("2026-10-13T08:30:00Z");

/** Android's default emulator position (Mountain View). */
const EMULATOR = { lat: 37.422, lng: -122.084 };
/** Just outside the first stop of the route, heading for the second. */
const ON_ROUTE = { lat: -1.3188, lng: 36.8425 };

/** Route 1, from school: Enterprise Road (nobody boards there), then Imara Daima, where Amani does. */
function world(pos: { lat: number; lng: number }) {
  const admin = new FakeSupabaseClient();
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: DRIVER };
  admin.uniqueIndex("bus_updates", ["trip_id", "stop_id", "dedupe_key"]); // as in the table
  // the fake returns whole rows, so the embedded `vehicle:` and `student:` are seeded as nested objects
  admin.seed("trips", [{
    id: TRIP_ID, tenant_id: "tenant-1", vehicle_id: "veh-1", route_id: "route-1", driver_id: DRIVER,
    direction: "from_school", status: "active", vehicle: { last_lat: pos.lat, last_lng: pos.lng },
  }]);
  admin.seed("route_stops", [
    { id: "stop-1", route_id: "route-1", name: "Enterprise Road", lat: -1.319, lng: 36.842, sequence: 1 },
    { id: "stop-2", route_id: "route-1", name: "Imara Daima", lat: -1.3277, lng: 36.8836, sequence: 2 },
  ]);
  admin.seed("student_transport", [
    { student_id: "stu-1", route_id: "route-1", stop_id: "stop-2", student: { full_name: "Amani Otieno", active: true } },
  ]);
  return { admin, asUser };
}

function tick(w: ReturnType<typeof world>, opts: { googleKey?: string | null; fetchImpl?: typeof fetch } = {}) {
  const req = new Request("https://example.com/bus-tick", {
    method: "POST", headers: new Headers({ Authorization: "Bearer user-token" }), body: JSON.stringify({ trip_id: TRIP_ID }),
  });
  return handle(req, { admin: w.admin, asUser: w.asUser, serviceKeys: ["service-role-key"], googleKey: opts.googleKey ?? null }, opts.fetchImpl, NOW);
}

describe("bus-tick: a new trip's first tick", () => {
  it("tells the families the bus has left, when the bus is nowhere near the route (FIG-770)", async () => {
    const w = world(EMULATOR);
    const body = await (await tick(w)).json();
    assertEquals(body.updates, 1);
    assertEquals(body.at.offRoute, true);
    const rows = w.admin.rowsIn("bus_updates");
    assertEquals(rows.length, 1);
    assertEquals([rows[0]!.kind, rows[0]!.title, rows[0]!.stop_id, rows[0]!.student_ids], ["trip_started", "Bus has left school", "stop-2", ["stu-1"]]);
    assertEquals(Number.isInteger(rows[0]!.distance_m), true); // the column is an int
  });

  it("does the same when Google answers but finds no road from there (the emulator's 'eta: traffic')", async () => {
    const w = world(EMULATOR);
    const noRoad = (() => Promise.resolve(new Response(JSON.stringify([{ destinationIndex: 0, condition: "ROUTE_NOT_FOUND" }])))) as typeof fetch;
    const body = await (await tick(w, { googleKey: "k", fetchImpl: noRoad })).json();
    assertEquals(body.eta, "traffic");
    assertEquals(body.updates, 1);
    assertEquals(w.admin.rowsIn("bus_updates").length, 1);
    assertEquals(w.admin.rowsIn("bus_updates")[0]!.eta_at != null, true); // an estimated time, since Google had none
  });

  it("tells them too when the bus sets off from the route itself", async () => {
    const w = world(ON_ROUTE);
    const body = await (await tick(w)).json();
    assertEquals(body.at.offRoute, false);
    assertEquals(body.updates, 1);
    assertEquals(w.admin.rowsIn("bus_updates")[0]!.title, "Bus has left school");
  });

  it("says it once: the next tick adds nothing", async () => {
    const w = world(EMULATOR);
    await tick(w);
    const second = await (await tick(w)).json();
    assertEquals(second.updates, 0);
    assertEquals(second.failed, 0);
    assertEquals(w.admin.rowsIn("bus_updates").length, 1);
  });

  it("reports an update it could not record, instead of answering as if nothing needed saying", async () => {
    const w = world(EMULATOR);
    w.admin.failNextWrite("bus_updates", "boom");
    const res = await tick(w);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.updates, 0);
    assertEquals(body.failed, 1);
    assertEquals(w.admin.rowsIn("bus_updates").length, 0);
  });
});
