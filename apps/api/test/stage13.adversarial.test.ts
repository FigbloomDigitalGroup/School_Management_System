import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 13 adversarial security, integrity, concurrency & pagination suite (S13-01..S13-14)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;
  let parentToken: string;
  let learner1Id: string;
  let learner2Id: string;
  let driver1Id: string;
  let driver2Id: string;

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
    teacherToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD },
      })
    ).json().token;
    parentToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD },
      })
    ).json().token;

    driver1Id = randomUUID();
    driver2Id = randomUUID();
    for (const [idx, dId] of [
      [1, driver1Id],
      [2, driver2Id],
    ] as const) {
      await ctx.pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, status)
         SELECT $1, $2, password_hash, $3, 'active' FROM users WHERE id = $4`,
        [dId, `driver-adv-${idx}@example.com`, `Driver Adv ${idx}`, ids.adminA],
      );
      await ctx.pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'driver', $3)`,
        [dId, ids.tenantA, `DR-010${idx}`],
      );
    }

    for (const [idx, assign] of [
      [1, (id: string) => (learner1Id = id)],
      [2, (id: string) => (learner2Id = id)],
    ] as const) {
      const l = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/learners`,
        headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
        payload: {
          full_name: `S13 Learner ${idx}`,
          admission_no: `S13-L-${idx}`,
          date_of_birth: "2014-06-15",
          gender: "female",
        },
      });
      expect(l.statusCode).toBe(201);
      assign(l.json().learner.id as string);
    }
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  function headers(token: string, tenant = ids.tenantA) {
    return { authorization: `Bearer ${token}`, "x-tenant-id": tenant };
  }

  it("S13-01 & S13-05: enforces 403 negative authorization across all Stage 13 write endpoints and blocks cross-tenant access", async () => {
    const dummyId = "00000000-0000-4000-8000-000000000111";
    const teacherDeniedRoutes: Array<{ method: "POST" | "PUT"; url: string; payload?: Record<string, unknown> }> = [
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/inventory/items`,
        payload: { name: "Unauthorized Item", category: "other", tracking: "asset" },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/inventory/items/${dummyId}/retire`,
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
        payload: { item_id: dummyId, holder_user_id: ids.teacherA },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/inventory/issues/${dummyId}/close`,
        payload: { status: "returned" },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/leave-requests/${dummyId}/review`,
        payload: { status: "approved" },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/activities`,
        payload: { name: "Unauthorized Club", category: "club" },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/activities/${dummyId}/patrons`,
        payload: { teacher_user_id: ids.teacherA },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/activities/${dummyId}/members`,
        payload: { learner_id: learner1Id },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/vehicles`,
        payload: { plate_number: "KBZ 001A" },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/transport-routes`,
        payload: { name: "Unauthorized Route" },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/transport-routes/${dummyId}/stops`,
        payload: { name: "Stop 1", sequence: 1 },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/vehicles/${dummyId}/assignments`,
        payload: { driver_user_id: driver1Id },
      },
      {
        method: "PUT",
        url: `/v1/tenants/${ids.tenantA}/learner-transport`,
        payload: { learner_id: learner1Id, route_id: dummyId },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/trips`,
        payload: { vehicle_id: dummyId, driver_user_id: driver1Id },
      },
      {
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/trips/${dummyId}/complete`,
      },
    ];

    for (const r of teacherDeniedRoutes) {
      const res = await ctx.app.inject({
        method: r.method,
        url: r.url,
        headers: headers(teacherToken),
        payload: r.payload,
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }

    // S13-05: Parent cannot submit staff leave requests -> 403
    const parentLeave = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests`,
      headers: headers(parentToken),
      payload: { start_on: "2026-11-10", end_on: "2026-11-12", reason: "Parent attempting staff leave" },
    });
    expect(parentLeave.statusCode).toBe(403);

    // Cross-tenant access denied -> 403
    const crossTenant = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/inventory/items`,
      headers: headers(adminToken, ids.tenantB),
    });
    expect(crossTenant.statusCode).toBe(403);
  });

  it("S13-02, S13-04 & S13-13: lost/damaged stock does not return to available pool, asset quantity=1 constraint is preserved, retirement blocks on open issues, and membership is enforced", async () => {
    // 1. Asset item (tracking='asset', quantity=1) closed as 'lost' stays unavailable without breaking inventory_items_asset_qty_chk
    const assetRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/items`,
      headers: headers(adminToken),
      payload: { name: "Microscope #1", category: "lab_equipment", tracking: "asset", asset_tag: "MIC-001" },
    });
    expect(assetRes.statusCode, assetRes.body).toBe(201);
    const assetId = assetRes.json().item.id as string;

    // Duplicate asset_tag -> 409 Conflict
    const dupTag = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/items`,
      headers: headers(adminToken),
      payload: { name: "Microscope #2", category: "lab_equipment", tracking: "asset", asset_tag: "mic-001" },
    });
    expect(dupTag.statusCode).toBe(409);

    // Foreign tenant holder_user_id (teacherB) or parent holder_user_id (parentA) -> 400
    const foreignHolder = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
      headers: headers(adminToken),
      payload: { item_id: assetId, holder_user_id: ids.teacherB, quantity: 1 },
    });
    expect(foreignHolder.statusCode).toBe(400);

    const parentHolder = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
      headers: headers(adminToken),
      payload: { item_id: assetId, holder_user_id: ids.parentA, quantity: 1 },
    });
    expect(parentHolder.statusCode).toBe(400);

    // Valid issue of asset
    const assetIssue = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
      headers: headers(adminToken),
      payload: { item_id: assetId, holder_user_id: ids.teacherA, quantity: 1 },
    });
    expect(assetIssue.statusCode, assetIssue.body).toBe(201);
    const assetIssueId = assetIssue.json().issue.id as string;

    // S13-13: Cannot retire item while it has open issue -> 409
    const retireWhileOpen = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/items/${assetId}/retire`,
      headers: headers(adminToken),
    });
    expect(retireWhileOpen.statusCode).toBe(409);

    // S13-13: Closing as 'lost' with returned_condition -> 400
    const lostWithCond = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues/${assetIssueId}/close`,
      headers: headers(adminToken),
      payload: { status: "lost", returned_condition: "good" },
    });
    expect(lostWithCond.statusCode).toBe(400);

    // Close as 'lost' without returned_condition -> 200
    const closedLost = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues/${assetIssueId}/close`,
      headers: headers(adminToken),
      payload: { status: "lost", note: "Lost during field trip" },
    });
    expect(closedLost.statusCode, closedLost.body).toBe(200);

    // Attempting to issue the lost asset again -> 400 (lost asset did NOT return to available pool!)
    const reissueLost = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/inventory/issues`,
      headers: headers(adminToken),
      payload: { item_id: assetId, holder_user_id: ids.adminA, quantity: 1 },
    });
    expect(reissueLost.statusCode).toBe(400);
  });

  it("S13-06 & S13-07: pending leave cancellation frees dates, and concurrent overlapping leave submissions serialize with 409", async () => {
    const sub = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests`,
      headers: headers(teacherToken),
      payload: { start_on: "2026-10-05", end_on: "2026-10-07", reason: "Medical appointment" },
    });
    expect(sub.statusCode, sub.body).toBe(201);
    const leaveId = sub.json().leave_request.id as string;

    // Cancel pending leave as requester
    const cancelled = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests/${leaveId}/cancel`,
      headers: headers(teacherToken),
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().leave_request.status).toBe("cancelled");

    // Cancelling again returns 409
    const cancelAgain = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/leave-requests/${leaveId}/cancel`,
      headers: headers(teacherToken),
    });
    expect(cancelAgain.statusCode).toBe(409);

    // S13-07: Two concurrent overlapping leave requests for the freed dates -> one 201, one 409
    const [c1, c2] = await Promise.all([
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/leave-requests`,
        headers: headers(teacherToken),
        payload: { start_on: "2026-10-05", end_on: "2026-10-07", reason: "Concurrent request A" },
      }),
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/leave-requests`,
        headers: headers(teacherToken),
        payload: { start_on: "2026-10-06", end_on: "2026-10-08", reason: "Concurrent request B" },
      }),
    ]);
    const statuses = [c1.statusCode, c2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("S13-03, S13-08, S13-09, S13-10, S13-12 & S13-14: activities & transport 404/409 error mapping, vehicle capacity, single active trip per driver, composite FK ON DELETE SET NULL (stop_id), and cursor pagination", async () => {
    const unknownId = "00000000-0000-4000-8000-000000000999";

    // S13-14: addPatron and listMembers return 404 on unknown activity
    const patron404 = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/activities/${unknownId}/patrons`,
      headers: headers(adminToken),
      payload: { teacher_user_id: ids.teacherA },
    });
    expect(patron404.statusCode).toBe(404);

    const members404 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/activities/${unknownId}/members`,
      headers: headers(adminToken),
    });
    expect(members404.statusCode).toBe(404);

    // S13-14: duplicate activity name -> 409
    const act1 = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/activities`,
      headers: headers(adminToken),
      payload: { name: "Debate Society", category: "club" },
    });
    expect(act1.statusCode).toBe(201);
    const actDup = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/activities`,
      headers: headers(adminToken),
      payload: { name: "  debate society ", category: "club" },
    });
    expect(actDup.statusCode).toBe(409);

    // Transport setup: 2 vehicles (v1 capacity=1, v2 capacity=10) and 1 route
    const v1Res = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/vehicles`,
      headers: headers(adminToken),
      payload: { plate_number: "KCA 101A", capacity: 1 },
    });
    expect(v1Res.statusCode).toBe(201);
    const v1Id = v1Res.json().vehicle.id as string;

    const v2Res = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/vehicles`,
      headers: headers(adminToken),
      payload: { plate_number: "KCA 102B", capacity: 10 },
    });
    expect(v2Res.statusCode).toBe(201);
    const v2Id = v2Res.json().vehicle.id as string;

    const routeRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/transport-routes`,
      headers: headers(adminToken),
      payload: { name: "Capacity Test Route" },
    });
    expect(routeRes.statusCode).toBe(201);
    const routeId = routeRes.json().route.id as string;

    const stopRes = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/transport-routes/${routeId}/stops`,
      headers: headers(adminToken),
      payload: { name: "Main Stage", sequence: 1 },
    });
    expect(stopRes.statusCode).toBe(201);
    const stopId = stopRes.json().stop.id as string;

    // S13-03: startTrip before driver is assigned to v1 -> 400
    const unassignedTrip = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/trips`,
      headers: headers(adminToken),
      payload: { vehicle_id: v1Id, driver_user_id: driver1Id, route_id: routeId },
    });
    expect(unassignedTrip.statusCode).toBe(400);

    // S13-08: Concurrent assignDriver on v1 serializes cleanly without 500
    const [a1, a2] = await Promise.all([
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/vehicles/${v1Id}/assignments`,
        headers: headers(adminToken),
        payload: { driver_user_id: driver1Id, route_id: routeId },
      }),
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/vehicles/${v1Id}/assignments`,
        headers: headers(adminToken),
        payload: { driver_user_id: driver1Id, route_id: routeId },
      }),
    ]);
    expect(a1.statusCode).toBe(204);
    expect(a2.statusCode).toBe(204);

    // S13-09: Capacity enforcement on route (v1 has capacity=1)
    const lt1 = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/learner-transport`,
      headers: headers(adminToken),
      payload: { learner_id: learner1Id, route_id: routeId, stop_id: stopId },
    });
    expect(lt1.statusCode, lt1.body).toBe(200);

    const lt2OverCap = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/learner-transport`,
      headers: headers(adminToken),
      payload: { learner_id: learner2Id, route_id: routeId, stop_id: stopId },
    });
    expect(lt2OverCap.statusCode).toBe(409);

    // S13-10: Deleting the stop as owner sets learner_transport.stop_id to NULL without failing on NOT NULL tenant_id
    await ctx.pool.query(`DELETE FROM route_stops WHERE id = $1`, [stopId]);
    const ltCheck = await ctx.pool.query<{ stop_id: string | null; route_id: string; tenant_id: string }>(
      `SELECT stop_id, route_id, tenant_id FROM learner_transport WHERE learner_id = $1`,
      [learner1Id],
    );
    expect(ltCheck.rows[0]).toEqual({ stop_id: null, route_id: routeId, tenant_id: ids.tenantA });

    // S13-03 & S13-09: Driver starts trip on v1; attempting to start a second concurrent active trip for the same driver on v2 returns 409
    await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/vehicles/${v2Id}/assignments`,
      headers: headers(adminToken),
      payload: { driver_user_id: driver1Id, route_id: routeId },
    });

    const trip1 = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/trips`,
      headers: headers(adminToken),
      payload: { vehicle_id: v1Id, driver_user_id: driver1Id, route_id: routeId },
    });
    expect(trip1.statusCode, trip1.body).toBe(201);

    const trip2SameDriver = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/trips`,
      headers: headers(adminToken),
      payload: { vehicle_id: v2Id, driver_user_id: driver1Id, route_id: routeId },
    });
    expect(trip2SameDriver.statusCode).toBe(409);

    // S13-12: Verify cursor pagination envelope on Stage 13 list endpoints
    const vehPage1 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/vehicles?limit=1`,
      headers: headers(adminToken),
    });
    expect(vehPage1.statusCode).toBe(200);
    expect(vehPage1.json().vehicles).toHaveLength(1);
    expect(vehPage1.json().page.next_cursor).toBeTruthy();

    const vehPage2 = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/vehicles?limit=1&cursor=${encodeURIComponent(vehPage1.json().page.next_cursor)}`,
      headers: headers(adminToken),
    });
    expect(vehPage2.statusCode).toBe(200);
    expect(vehPage2.json().vehicles).toHaveLength(1);
    expect(vehPage2.json().vehicles[0].id).not.toBe(vehPage1.json().vehicles[0].id);
  });
});
