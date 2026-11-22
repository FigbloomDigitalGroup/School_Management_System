import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

const PASSWORD = "correct-horse-battery";

describe("Transport operations: complete morning/afternoon journey, guardian visibility, notifications, hostile access", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let T: string;
  const tokens: Record<string, string> = {};
  const u: Record<string, string> = {};
  let vehicleId: string;
  let routeId: string;
  let stop1: string;
  let stop2: string;
  const learners = {} as { l1: string; l2: string; l3: string; l4: string };

  const call = (who: string, method: "GET" | "POST" | "PUT", path: string, payload?: unknown, tenant = T) =>
    ctx.app.inject({
      method,
      url: `/v1/tenants/${tenant}${path}`,
      headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": tenant },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  async function mkUser(key: string, email: string, role: string, tenant = ids.tenantA) {
    const id = randomUUID();
    u[key] = id;
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, $3, password_hash, $4, 'active' FROM users WHERE id = $2`,
      [id, ids.adminA, email, `${key} Person`],
    );
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1,$2,$3,$4)`, [
      id,
      tenant,
      role,
      `${role === "driver" ? "DR" : "PT"}-${String(1000 + Object.keys(u).length)}`,
    ]);
    const login = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } });
    expect(login.statusCode, login.body).toBe(200);
    tokens[key] = login.json().token;
  }

  async function linkGuardian(parentKey: string, learnerId: string, name: string) {
    const g = (
      await ctx.pool.query(`INSERT INTO guardians (tenant_id, full_name, phone) VALUES ($1,$2,'0700000000') RETURNING id`, [T, name])
    ).rows[0].id as string;
    await ctx.pool.query(`INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship) VALUES ($1,$2,$3,'mother')`, [T, g, learnerId]);
    const inv = (
      await ctx.pool.query(
        `INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, status,
            contact_verification, created_at, expires_at, accepted_at, accepted_by)
         VALUES ($1,$2,$3,'email','p@example.com',$4,'accepted','token_and_contact_echo', now() - interval '1 hour', now() + interval '1 day', now(), $5)
         RETURNING id`,
        [T, g, learnerId, createHash("sha256").update(randomUUID()).digest("hex"), u[parentKey]],
      )
    ).rows[0].id as string;
    await ctx.pool.query(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1,$2,$3,$4)`, [T, g, u[parentKey], inv]);
  }

  const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString();
  const notifs = async (who: string) => (await call(who, "GET", "/me/transport/notifications")).json().notifications as Array<{ kind: string; learner_id: string; delivery_status: string }>;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    T = ids.tenantA;
    tokens.admin = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })).json().token;
    await mkUser("driver1", "driver1@example.com", "driver");
    await mkUser("driver2", "driver2@example.com", "driver");
    await mkUser("parent1", "parent1@example.com", "parent");
    await mkUser("parent2", "parent2@example.com", "parent");

    const mk = async (path: string, payload: unknown) => {
      const r = await call("admin", "POST", path, payload);
      expect(r.statusCode, r.body).toBe(201);
      return r.json();
    };
    vehicleId = (await mk("/vehicles", { plate_number: "KDB 500B", capacity: 30 })).vehicle.id;
    routeId = (await mk("/transport-routes", { name: "Ops loop" })).route.id;
    stop1 = (await mk(`/transport-routes/${routeId}/stops`, { name: "Gate A", sequence: 1, lat: -1.286, lng: 36.817 })).stop.id;
    stop2 = (await mk(`/transport-routes/${routeId}/stops`, { name: "Gate B", sequence: 2, lat: -1.29, lng: 36.82 })).stop.id;
    for (const [k, adm] of [["l1", "OP-001"], ["l2", "OP-002"], ["l3", "OP-003"], ["l4", "OP-004"]] as const) {
      learners[k] = (await mk("/learners", { full_name: `Rider ${k}`, admission_no: adm, date_of_birth: "2014-02-02", gender: "female" })).learner.id;
    }
    for (const k of ["l1", "l2", "l3"] as const) {
      const r = await call("admin", "PUT", "/learner-transport", { learner_id: learners[k], route_id: routeId, stop_id: k === "l1" ? stop1 : stop2 });
      expect(r.statusCode, r.body).toBe(200);
    }
    const asg = await call("admin", "POST", `/vehicles/${vehicleId}/assignments`, { driver_user_id: u.driver1, route_id: routeId });
    expect(asg.statusCode, asg.body).toBe(204);
    await linkGuardian("parent1", learners.l1, "Parent One");
    await linkGuardian("parent2", learners.l4, "Parent Two");
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  let morningTrip: string;
  let afternoonTrip: string;

  it("morning journey: driver starts, guardian sees live bus, pickup/not-boarded/arrival notify only the right guardians", async () => {
    // before any trip the guardian sees the assignment but no active trip
    const idle = (await call("parent1", "GET", "/me/transport")).json().children;
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ learner_id: learners.l1, assigned: true, vehicle_plate: "KDB 500B", active_trip: null, location: null });
    expect(idle[0].stop.name).toBe("Gate A");
    expect(idle[0].driver_first_name).toBe("driver1");

    const start = await call("driver1", "POST", "/driver/trips", { vehicle_id: vehicleId, direction: "to_school" });
    expect(start.statusCode, start.body).toBe(201);
    morningTrip = start.json().trip.id;
    expect((await notifs("parent1")).map((n) => n.kind)).toEqual(["trip_started"]);
    expect(await notifs("parent2")).toEqual([]); // learner l4 is not on this route

    const fix = await call("driver1", "POST", `/trips/${morningTrip}/driver-location`, { lat: -1.28, lng: 36.81, recorded_at: iso(-20) });
    expect(fix.statusCode, fix.body).toBe(201);
    const live = (await call("parent1", "GET", "/me/transport")).json().children[0];
    expect(live.active_trip).toMatchObject({ id: morningTrip, direction: "to_school", learner_status: "waiting" });
    expect(live.location.status).toBe("live");
    expect(live.location.lat).toBeCloseTo(-1.28);
    expect(live.driver_first_name).toBe("driver1");

    // pickup of l1; duplicate is an idempotent replay (no second notification)
    const board = await call("driver1", "POST", `/trips/${morningTrip}/events`, { event_type: "learner_boarded", learner_id: learners.l1, stop_id: stop1 });
    expect(board.statusCode, board.body).toBe(201);
    const again = await call("driver1", "POST", `/trips/${morningTrip}/events`, { event_type: "learner_boarded", learner_id: learners.l1, stop_id: stop1 });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(again.json().event.id).toBe(board.json().event.id);
    expect((await notifs("parent1")).filter((n) => n.kind === "learner_boarded")).toHaveLength(1);

    // l2 not boarded (no guardian account linked -> nobody notified, no error); l3 stays waiting
    const miss = await call("driver1", "POST", `/trips/${morningTrip}/events`, { event_type: "learner_not_boarded", learner_id: learners.l2 });
    expect(miss.statusCode, miss.body).toBe(201);
    // a learner cannot be both boarded and not boarded
    const bad = await call("driver1", "POST", `/trips/${morningTrip}/events`, { event_type: "learner_not_boarded", learner_id: learners.l1 });
    expect(bad.statusCode).toBe(409);
    // a learner not on the route cannot be boarded
    const stranger = await call("driver1", "POST", `/trips/${morningTrip}/events`, { event_type: "learner_boarded", learner_id: learners.l4 });
    expect(stranger.statusCode).toBe(409);

    const arrive = await call("driver1", "POST", `/trips/${morningTrip}/events`, { event_type: "school_arrived" });
    expect(arrive.statusCode, arrive.body).toBe(201);
    const kinds = (await notifs("parent1")).map((n) => n.kind).sort();
    expect(kinds).toEqual(["learner_boarded", "school_arrived", "trip_started"]);
    // truthful delivery status: no provider is configured, so nothing is ever labelled "sent"
    expect((await notifs("parent1")).every((n) => n.delivery_status === "not_configured")).toBe(true);

    const detail = (await call("driver1", "GET", `/trips/${morningTrip}`)).json();
    const byLearner = Object.fromEntries(detail.manifest.map((m: { learner_id: string; status: string }) => [m.learner_id, m.status]));
    expect(byLearner).toMatchObject({ [learners.l1]: "boarded", [learners.l2]: "not_boarded", [learners.l3]: "waiting" });

    const done = await call("driver1", "POST", `/trips/${morningTrip}/finish`, {});
    expect(done.statusCode, done.body).toBe(204);
    const after = (await call("parent1", "GET", "/me/transport")).json().children[0];
    expect(after.active_trip).toBeNull();
    expect(after.location).toBeNull();
    // a completed trip is final
    expect((await call("driver1", "POST", `/trips/${morningTrip}/events`, { event_type: "delayed" })).statusCode).toBe(409);
    expect((await call("driver1", "POST", `/trips/${morningTrip}/finish`, {})).statusCode).toBe(409);
    expect((await call("driver1", "POST", `/trips/${morningTrip}/driver-location`, { lat: -1.28, lng: 36.81 })).statusCode).toBe(409);
  });

  it("afternoon journey is a separate trip: boarding, no completion with riders on board, drop-off notification, history", async () => {
    const start = await call("driver1", "POST", "/driver/trips", { vehicle_id: vehicleId, direction: "from_school" });
    expect(start.statusCode, start.body).toBe(201);
    afternoonTrip = start.json().trip.id;
    expect(afternoonTrip).not.toBe(morningTrip);

    // school_arrived is meaningless on the way home
    expect((await call("driver1", "POST", `/trips/${afternoonTrip}/events`, { event_type: "school_arrived" })).statusCode).toBe(409);
    // no drop-off before boarding
    expect((await call("driver1", "POST", `/trips/${afternoonTrip}/events`, { event_type: "learner_alighted", learner_id: learners.l1 })).statusCode).toBe(409);

    expect((await call("driver1", "POST", `/trips/${afternoonTrip}/events`, { event_type: "learner_boarded", learner_id: learners.l1 })).statusCode).toBe(201);
    // cannot complete while a boarded learner has no drop-off
    const early = await call("driver1", "POST", `/trips/${afternoonTrip}/finish`, {});
    expect(early.statusCode).toBe(409);
    expect((await call("driver1", "POST", `/trips/${afternoonTrip}/events`, { event_type: "stop_arrived", stop_id: stop1 })).statusCode).toBe(201);
    const drop = await call("driver1", "POST", `/trips/${afternoonTrip}/events`, { event_type: "learner_alighted", learner_id: learners.l1, stop_id: stop1 });
    expect(drop.statusCode, drop.body).toBe(201);

    const mid = (await notifs("parent1")).map((n) => n.kind);
    expect(mid).toContain("learner_dropped_off");
    // once dropped off the guardian no longer sees the bus location
    await call("driver1", "POST", `/trips/${afternoonTrip}/driver-location`, { lat: -1.28, lng: 36.81, recorded_at: iso(-5) });
    const seen = (await call("parent1", "GET", "/me/transport")).json().children[0];
    expect(seen.active_trip.learner_status).toBe("dropped_off");
    expect(seen.location).toBeNull();

    expect((await call("driver1", "POST", `/trips/${afternoonTrip}/finish`, {})).statusCode).toBe(204);

    const history = (await call("admin", "GET", "/trips")).json();
    expect(history.trips.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([morningTrip, afternoonTrip]));
    const detail = (await call("admin", "GET", `/trips/${afternoonTrip}`)).json();
    expect(detail.events.map((e: { event_type: string }) => e.event_type)).toEqual([
      "trip_started", "learner_boarded", "stop_arrived", "learner_alighted", "trip_completed",
    ]);
    // events are append-only for the application role
    const g = await ctx.pool.query(
      `SELECT has_table_privilege('figbloom_app','trip_events','UPDATE') u, has_table_privilege('figbloom_app','trip_events','DELETE') d,
              has_table_privilege('figbloom_app','transport_notifications','INSERT') ni`,
    );
    expect(g.rows[0]).toEqual({ u: false, d: false, ni: false });
  });

  it("GPS integrity: out-of-order, stale, implausible and duplicate fixes; stale location is never shown as live", async () => {
    const s = await call("driver1", "POST", "/driver/trips", { vehicle_id: vehicleId, direction: "to_school" });
    const trip = s.json().trip.id as string;
    const t0 = iso(0);
    expect((await call("driver1", "POST", `/trips/${trip}/driver-location`, { lat: -1.28, lng: 36.81, recorded_at: t0 })).statusCode).toBe(201);
    // exact resend -> replay, no second row
    const dup = await call("driver1", "POST", `/trips/${trip}/driver-location`, { lat: -1.28, lng: 36.81, recorded_at: t0 });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().replayed).toBe(true);
    // same timestamp, different position
    expect((await call("driver1", "POST", `/trips/${trip}/driver-location`, { lat: -1.3, lng: 36.9, recorded_at: t0 })).statusCode).toBe(409);
    // older than the newest stored fix
    expect((await call("driver1", "POST", `/trips/${trip}/driver-location`, { lat: -1.28, lng: 36.81, recorded_at: iso(-300) })).statusCode).toBe(409);
    // older than 10 minutes -> refused as stale (replay of an old capture)
    expect((await call("driver1", "POST", `/trips/${trip}/driver-location`, { lat: -1.28, lng: 36.81, recorded_at: iso(-3600) })).statusCode).toBe(400);
    // teleport 100 km in 10 seconds
    expect((await call("driver1", "POST", `/trips/${trip}/driver-location`, { lat: -0.4, lng: 36.81, recorded_at: iso(10) })).statusCode).toBe(400);
    const rows = await ctx.pool.query(`SELECT count(*)::int n FROM vehicle_locations WHERE trip_id = $1`, [trip]);
    expect(rows.rows[0].n).toBe(1);

    // push the only fix to 5 minutes old -> guardian sees "stale" with no coordinates
    await ctx.pool.query(`UPDATE vehicle_locations SET recorded_at = now() - interval '5 minutes' WHERE trip_id = $1`, [trip]);
    const stale = (await call("parent1", "GET", "/me/transport")).json().children[0];
    expect(stale.location).toMatchObject({ status: "stale", lat: null, lng: null });

    // admin cancels with a reason: guardians are told, bus is no longer active, no more fixes
    expect((await call("admin", "POST", `/trips/${trip}/cancel`, {})).statusCode).toBe(400);
    expect((await call("admin", "POST", `/trips/${trip}/cancel`, { reason: "Bus breakdown" })).statusCode).toBe(204);
    expect((await notifs("parent1")).map((n) => n.kind)).toContain("trip_cancelled");
    expect((await call("parent1", "GET", "/me/transport")).json().children[0].active_trip).toBeNull();
    expect((await call("driver1", "POST", `/trips/${trip}/driver-location`, { lat: -1.28, lng: 36.81 })).statusCode).toBe(409);
    // a cancelled trip cannot be revived at the database level either
    await expect(ctx.pool.query(`UPDATE trips SET status = 'active', ended_at = NULL, cancel_reason = NULL WHERE id = $1`, [trip])).rejects.toThrow(/final/);
  });

  it("hostile access: unrelated driver, guardians, other tenants and non-drivers are refused", async () => {
    const s = await call("driver1", "POST", "/driver/trips", { vehicle_id: vehicleId, direction: "to_school" });
    const trip = s.json().trip.id as string;

    // another driver of the same school cannot operate, read or spoof this trip (indistinguishable from missing)
    expect((await call("driver2", "POST", `/trips/${trip}/driver-location`, { lat: -1.28, lng: 36.81 })).statusCode).toBe(404);
    expect((await call("driver2", "POST", `/trips/${trip}/events`, { event_type: "delayed" })).statusCode).toBe(404);
    expect((await call("driver2", "POST", `/trips/${trip}/cancel`, { reason: "x" })).statusCode).toBe(404);
    expect((await call("driver2", "GET", `/trips/${trip}`)).statusCode).toBe(404);
    // and cannot start a trip on a vehicle they are not assigned to
    expect((await call("driver2", "POST", "/driver/trips", { vehicle_id: vehicleId, direction: "to_school" })).statusCode).toBe(400);
    // drivers have no fleet-wide location history
    expect((await call("driver1", "GET", `/vehicles/${vehicleId}/locations`)).statusCode).toBe(403);
    expect((await call("driver1", "GET", "/trips")).statusCode).toBe(403);
    // client-supplied driver identity is not accepted on the driver endpoint
    expect((await call("driver1", "POST", "/driver/trips", { vehicle_id: vehicleId, direction: "to_school", driver_user_id: u.driver2 })).statusCode).toBe(400);

    // guardians cannot drive, cannot read fleet data, and see only their own children
    expect((await call("parent1", "POST", `/trips/${trip}/events`, { event_type: "learner_boarded", learner_id: learners.l1 })).statusCode).toBe(403);
    expect((await call("parent1", "POST", `/trips/${trip}/driver-location`, { lat: 0, lng: 0 })).statusCode).toBe(403);
    expect((await call("parent1", "GET", `/trips/${trip}`)).statusCode).toBe(403);
    expect((await call("parent1", "GET", `/vehicles/${vehicleId}/locations`)).statusCode).toBe(403);
    const p2 = (await call("parent2", "GET", "/me/transport")).json().children;
    expect(p2).toHaveLength(1);
    expect(p2[0]).toMatchObject({ learner_id: learners.l4, assigned: false, active_trip: null, location: null });
    expect(JSON.stringify(p2)).not.toContain(learners.l1);
    expect(await notifs("parent2")).toEqual([]);
    // staff/driver cannot use the guardian endpoint
    expect((await call("driver1", "GET", "/me/transport")).statusCode).toBe(403);

    // cross-tenant: an administrator of another school cannot touch this school's trip
    const crossTenant = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/trips/${trip}`,
      headers: { authorization: `Bearer ${tokens.admin}`, "x-tenant-id": ids.tenantB },
    });
    expect([401, 403, 404]).toContain(crossTenant.statusCode);

    // revoked guardian account loses access immediately
    await ctx.pool.query(`UPDATE guardian_accounts SET revoked_at = now(), revoke_reason = 'test' WHERE user_id = $1`, [u.parent1]);
    expect((await call("parent1", "GET", "/me/transport")).json().children).toEqual([]);
    await call("driver1", "POST", `/trips/${trip}/cancel`, { reason: "end of test" });
  });

  it("driver reassignment keeps history and the old driver loses the vehicle", async () => {
    const r = await call("admin", "POST", `/vehicles/${vehicleId}/assignments`, { driver_user_id: u.driver2, route_id: routeId });
    expect(r.statusCode, r.body).toBe(204);
    const hist = await ctx.pool.query(`SELECT driver_user_id, active FROM vehicle_assignments WHERE vehicle_id = $1 ORDER BY created_at`, [vehicleId]);
    expect(hist.rows).toHaveLength(2);
    expect(hist.rows.filter((x) => x.active)).toEqual([{ driver_user_id: u.driver2, active: true }]);
    expect((await call("driver1", "POST", "/driver/trips", { vehicle_id: vehicleId, direction: "to_school" })).statusCode).toBe(400);
    expect((await call("driver2", "POST", "/driver/trips", { vehicle_id: vehicleId, direction: "to_school" })).statusCode).toBe(201);
  });
});
