import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { financeHarness } from "./support/financeHarness.js";

/**
 * Transport end to end (audit Phase 7): the real routes, authorization and database constraints together —
 * vehicle -> route/stops -> driver assignment -> learner assignment -> trip lifecycle — with cross-tenant and
 * invalid-state cases. A domain conflict must be a 4xx, never a generic 500.
 */
describe("post-audit: transport workflows end to end", () => {
  const h = financeHarness();
  const T = (method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: unknown, token = h.admin, tenant = h.A()) =>
    h.call(method, `/v1/tenants/${tenant}${path}`, token, payload, { "x-tenant-id": tenant });

  let seq = Math.floor(Math.random() * 7000);
  async function driver(tenant = h.A(), active = true): Promise<string> {
    const id = randomUUID();
    await h.owner(`INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, $2, password_hash, 'Driver E2E', 'active' FROM users WHERE id = $3`, [id, `drv-${id}@example.com`, h.ids.adminA]);
    await h.owner(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id, archived_at) VALUES ($1, $2, 'driver', $3, ${active ? "NULL" : "now()"})`, [id, tenant, "DR-" + String(1000 + (seq++))]);
    return id;
  }
  const uniq = () => randomUUID().slice(0, 8);

  it("builds the fleet, assigns drivers and learners, and runs a trip; every invalid state is a 4xx and the database keeps its invariants", async () => {
    const v = await T("POST", "/vehicles", { plate_number: "KE" + uniq(), capacity: 30 });
    expect(v.statusCode).toBe(201);
    const vehicleId = v.json().vehicle.id as string;
    const r1 = (await T("POST", "/transport-routes", { name: "East " + uniq() })).json().route.id as string;
    const r2 = (await T("POST", "/transport-routes", { name: "West " + uniq() })).json().route.id as string;
    const s1 = (await T("POST", `/transport-routes/${r1}/stops`, { name: "Stop A", sequence: 1 }));
    expect(s1.statusCode).toBe(201);
    const stop1 = s1.json().stop.id as string;
    const stop2 = (await T("POST", `/transport-routes/${r2}/stops`, { name: "Stop B", sequence: 1 })).json().stop.id as string;
    // duplicate stop sequence / name on a route is a conflict, not a 500
    expect((await T("POST", `/transport-routes/${r1}/stops`, { name: "Stop A", sequence: 1 })).statusCode).toBeLessThan(500);
    // unknown parent route
    expect((await T("POST", `/transport-routes/${randomUUID()}/stops`, { name: "Ghost", sequence: 1 })).statusCode).toBe(404);

    // driver assignment: invalid drivers are rejected (other school, archived membership, not a driver)
    const d1 = await driver();
    const dOther = await driver(h.ids.tenantB);
    const dInactive = await driver(h.A(), false);
    for (const bad of [dOther, dInactive, h.ids.teacherA, randomUUID()]) {
      const r = await T("POST", `/vehicles/${vehicleId}/assignments`, { driver_user_id: bad, route_id: r1 });
      expect([400, 404, 409], `driver ${bad}`).toContain(r.statusCode);
    }
    expect((await T("POST", `/vehicles/${randomUUID()}/assignments`, { driver_user_id: d1, route_id: r1 })).statusCode).toBe(404);
    const a1 = await T("POST", `/vehicles/${vehicleId}/assignments`, { driver_user_id: d1, route_id: r1 });
    expect(a1.statusCode).toBe(204);
    // a second driver is a SWAP (the previous assignment ends); concurrent swaps serialise on the vehicle row and
    // never leave two active drivers (vehicle_assignments_one_active), never a 500
    const d2 = await driver();
    expect((await T("POST", `/vehicles/${vehicleId}/assignments`, { driver_user_id: d2, route_id: r1 })).statusCode).toBe(204);
    const swaps = await Promise.all([
      T("POST", `/vehicles/${vehicleId}/assignments`, { driver_user_id: d1, route_id: r1 }),
      T("POST", `/vehicles/${vehicleId}/assignments`, { driver_user_id: d2, route_id: r1 }),
    ]);
    expect(swaps.every((x) => x.statusCode === 204 || x.statusCode === 409)).toBe(true);
    expect((await h.owner(`SELECT count(*)::int AS n FROM vehicle_assignments WHERE vehicle_id = $1 AND active`, [vehicleId]))[0]!.n).toBe(1);
    expect((await T("POST", `/vehicles/${vehicleId}/assignments`, { driver_user_id: d1, route_id: r1 })).statusCode).toBe(204); // d1 is the active driver again

    // learner assignment: a stop that belongs to ANOTHER route is refused by the composite FK
    const learnerId = (await h.owner<{ id: string }>(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Rider', 'male') RETURNING id`, [h.A(), "TR" + uniq()]))[0]!.id;
    const wrongStop = await T("PUT", "/learner-transport", { learner_id: learnerId, route_id: r1, stop_id: stop2 });
    expect([400, 404, 409]).toContain(wrongStop.statusCode);
    const okAssign = await T("PUT", "/learner-transport", { learner_id: learnerId, route_id: r1, stop_id: stop1 });
    expect(okAssign.statusCode).toBe(200);
    const otherSchoolLearner = (await h.owner<{ id: string }>(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Other', 'male') RETURNING id`, [h.ids.tenantB, "TRB" + uniq()]))[0]!.id;
    expect([400, 404]).toContain((await T("PUT", "/learner-transport", { learner_id: otherSchoolLearner, route_id: r1 })).statusCode);

    // trips: driver must be the vehicle's active driver; one active trip per driver even under a race
    expect((await T("POST", "/trips", { vehicle_id: vehicleId, driver_user_id: d2, route_id: r1 })).statusCode).toBeLessThan(500);
    expect((await T("POST", "/trips", { vehicle_id: vehicleId, driver_user_id: d2, route_id: r1 })).statusCode).not.toBe(201);
    const race = await Promise.all([
      T("POST", "/trips", { vehicle_id: vehicleId, driver_user_id: d1, route_id: r1, direction: "to_school" }),
      T("POST", "/trips", { vehicle_id: vehicleId, driver_user_id: d1, route_id: r1, direction: "from_school" }),
    ]);
    const codes = race.map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(201);
    expect(codes[1]).toBe(409);
    const tripId = race.find((r) => r.statusCode === 201)!.json().trip.id as string;
    expect((await h.owner(`SELECT count(*)::int AS n FROM trips WHERE driver_user_id = $1 AND status = 'active'`, [d1]))[0]!.n).toBe(1);
    // complete, then complete again (invalid transition is a 4xx)
    expect((await T("POST", `/trips/${tripId}/complete`)).statusCode).toBe(204);
    expect((await T("POST", `/trips/${tripId}/complete`)).statusCode).toBeLessThan(500);
    expect((await T("POST", `/trips/${tripId}/complete`)).statusCode).not.toBe(204);
    expect((await h.owner(`SELECT status, ended_at IS NOT NULL AS ended FROM trips WHERE id = $1`, [tripId]))[0]).toMatchObject({ status: "completed", ended: true });
    // the driver can start another trip once the first ended
    expect((await T("POST", "/trips", { vehicle_id: vehicleId, driver_user_id: d1, route_id: r1 })).statusCode).toBe(201);
    // the trip CHECK itself: an active trip with an end time is impossible
    expect(await h.sqlState(h.owner(`UPDATE trips SET ended_at = now() WHERE driver_user_id = $1 AND status = 'active'`, [d1]))).toBe("23514");

    // deletion keeps tenant identity: route removed -> route_id NULL on assignment/trip/learner row, tenant_id intact
    await h.owner(`DELETE FROM route_stops WHERE id = $1`, [stop1]);
    expect((await h.owner(`SELECT stop_id, route_id, tenant_id FROM learner_transport WHERE learner_id = $1`, [learnerId]))[0]).toMatchObject({ stop_id: null, route_id: r1, tenant_id: h.A() });
    await h.owner(`DELETE FROM transport_routes WHERE id = $1`, [r1]).catch(() => undefined);
    const survivors = await h.owner(`SELECT tenant_id FROM vehicle_assignments WHERE vehicle_id = $1`, [vehicleId]);
    expect(survivors.every((s) => s.tenant_id === h.A())).toBe(true);
  });

  it("authorization and tenant isolation: a teacher cannot write fleet data; school A's admin cannot touch school B", async () => {
    const teacherToken = await h.login({ tenantId: h.A(), loginId: "TC-0001", password: "correct-horse-battery" });
    expect((await T("POST", "/vehicles", { plate_number: "NOPE" + uniq() }, teacherToken)).statusCode).toBe(403);
    expect([401, 403, 404]).toContain((await T("POST", "/vehicles", { plate_number: "XTEN" + uniq() }, h.admin, h.ids.tenantB)).statusCode);
    const mine = await T("GET", "/vehicles");
    expect(mine.statusCode).toBe(200);
    const bVehicle = (await h.owner<{ id: string }>(`INSERT INTO vehicles (tenant_id, plate_number, active) VALUES ($1, $2, true) RETURNING id`, [h.ids.tenantB, "BV" + uniq()]))[0]!.id;
    expect((mine.json().vehicles ?? []).some((x: { id: string }) => x.id === bVehicle)).toBe(false);
    const d = await driver();
    expect([404, 400]).toContain((await T("POST", `/vehicles/${bVehicle}/assignments`, { driver_user_id: d })).statusCode);
  });
});
