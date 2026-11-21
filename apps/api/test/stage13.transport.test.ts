import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 13 transport (no GPS)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let learnerId: string;
  let driverId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a@example.com", password: PASSWORD },
      })
    ).json().token;

    driverId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, 'driver-a@example.com', password_hash, 'Driver A', 'active' FROM users WHERE id = $2`,
      [driverId, ids.adminA],
    );
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'driver', 'DR-0001')`,
      [driverId, ids.tenantA],
    );

    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "Bus Rider", admission_no: "BR-001", date_of_birth: "2014-02-02", gender: "female" },
    });
    expect(learner.statusCode, learner.body).toBe(201);
    learnerId = learner.json().learner.id as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("creates vehicle, route, stop, assignments and a trip lifecycle", async () => {
    const headers = { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA };

    const vehicle = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/vehicles`,
      headers,
      payload: { plate_number: "KDA 123A", make_model: "Toyota Coaster", capacity: 30 },
    });
    expect(vehicle.statusCode, vehicle.body).toBe(201);
    const vehicleId = vehicle.json().vehicle.id as string;

    const route = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/transport-routes`,
      headers,
      payload: { name: "Morning West", description: "West estate loop" },
    });
    expect(route.statusCode, route.body).toBe(201);
    const routeId = route.json().route.id as string;

    const stop = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/transport-routes/${routeId}/stops`,
      headers,
      payload: { name: "Gate A", sequence: 1, lat: -1.29, lng: 36.82 },
    });
    expect(stop.statusCode, stop.body).toBe(201);
    const stopId = stop.json().stop.id as string;

    const assignment = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/vehicles/${vehicleId}/assignments`,
      headers,
      payload: { driver_user_id: driverId, route_id: routeId },
    });
    expect(assignment.statusCode, assignment.body).toBe(204);

    const lt = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/learner-transport`,
      headers,
      payload: { learner_id: learnerId, route_id: routeId, stop_id: stopId },
    });
    expect(lt.statusCode, lt.body).toBe(200);
    expect(lt.json().assignment).toMatchObject({ learner_id: learnerId, route_id: routeId, stop_id: stopId });

    const trip = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/trips`,
      headers,
      payload: { vehicle_id: vehicleId, driver_user_id: driverId, route_id: routeId, direction: "to_school" },
    });
    expect(trip.statusCode, trip.body).toBe(201);
    const tripId = trip.json().trip.id as string;

    const complete = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/trips/${tripId}/complete`,
      headers,
    });
    expect(complete.statusCode).toBe(204);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/vehicles`,
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().vehicles.some((v: { id: string }) => v.id === vehicleId)).toBe(true);
  });
});
