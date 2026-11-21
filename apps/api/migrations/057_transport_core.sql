-- Stage 13: transport core without live GPS (legacy fleet 20260903000003 shape). Forward-only.
-- Deferred: vehicle_locations, bus_updates, realtime pings, FCM bus-tick.

INSERT INTO permissions (code, description) VALUES
  ('resource.transport.read', 'Read vehicles, routes, assignments and learner transport'),
  ('resource.transport.write', 'Manage fleet, routes, stops, assignments and learner transport')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.transport.read'),
  ('school_admin', 'resource.transport.write'),
  ('driver', 'resource.transport.read')
ON CONFLICT DO NOTHING;

CREATE TABLE vehicles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  plate_number text NOT NULL,
  make_model   text,
  capacity     integer,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicles_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT vehicles_plate_chk CHECK (char_length(btrim(plate_number)) BETWEEN 1 AND 40),
  CONSTRAINT vehicles_make_chk CHECK (make_model IS NULL OR char_length(make_model) <= 120),
  CONSTRAINT vehicles_capacity_chk CHECK (capacity IS NULL OR capacity > 0)
);
CREATE UNIQUE INDEX vehicles_tenant_plate ON vehicles (tenant_id, lower(btrim(plate_number)));

CREATE TABLE transport_routes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_routes_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT transport_routes_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT transport_routes_desc_chk CHECK (char_length(description) <= 1000)
);
CREATE UNIQUE INDEX transport_routes_tenant_name ON transport_routes (tenant_id, lower(btrim(name)));

CREATE TABLE route_stops (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  route_id  uuid NOT NULL,
  name      text NOT NULL,
  sequence  integer NOT NULL,
  -- Static stop coordinates (route planning). Not live GPS pings.
  lat       double precision,
  lng       double precision,
  CONSTRAINT route_stops_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT route_stops_route_fk FOREIGN KEY (route_id, tenant_id) REFERENCES transport_routes (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT route_stops_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT route_stops_sequence_chk CHECK (sequence >= 1),
  CONSTRAINT route_stops_coords_chk CHECK (
    (lat IS NULL AND lng IS NULL) OR (lat IS NOT NULL AND lng IS NOT NULL AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)
  )
);
CREATE UNIQUE INDEX route_stops_route_sequence ON route_stops (route_id, sequence);
CREATE INDEX route_stops_tenant_route_idx ON route_stops (tenant_id, route_id);

CREATE TABLE vehicle_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  vehicle_id      uuid NOT NULL,
  driver_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  route_id        uuid,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_assignments_vehicle_fk FOREIGN KEY (vehicle_id, tenant_id) REFERENCES vehicles (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT vehicle_assignments_route_fk FOREIGN KEY (route_id, tenant_id) REFERENCES transport_routes (id, tenant_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX vehicle_assignments_one_active ON vehicle_assignments (vehicle_id) WHERE active;
CREATE INDEX vehicle_assignments_driver_idx ON vehicle_assignments (tenant_id, driver_user_id) WHERE active;

CREATE TABLE learner_transport (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  learner_id uuid NOT NULL,
  route_id   uuid NOT NULL,
  stop_id    uuid,
  CONSTRAINT learner_transport_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT learner_transport_route_fk FOREIGN KEY (route_id, tenant_id) REFERENCES transport_routes (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT learner_transport_stop_fk FOREIGN KEY (stop_id, tenant_id) REFERENCES route_stops (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT learner_transport_learner_uniq UNIQUE (learner_id)
);
CREATE INDEX learner_transport_route_idx ON learner_transport (tenant_id, route_id);

CREATE TABLE trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  vehicle_id   uuid NOT NULL,
  route_id     uuid,
  driver_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  direction    text NOT NULL DEFAULT 'to_school',
  status       text NOT NULL DEFAULT 'active',
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  CONSTRAINT trips_vehicle_fk FOREIGN KEY (vehicle_id, tenant_id) REFERENCES vehicles (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT trips_route_fk FOREIGN KEY (route_id, tenant_id) REFERENCES transport_routes (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT trips_direction_chk CHECK (direction IN ('to_school', 'from_school')),
  CONSTRAINT trips_status_chk CHECK (status IN ('active', 'completed', 'cancelled')),
  CONSTRAINT trips_ended_chk CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX trips_tenant_status_idx ON trips (tenant_id, status, started_at DESC);
CREATE UNIQUE INDEX trips_one_active_per_vehicle ON trips (vehicle_id) WHERE status = 'active';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vehicles', 'transport_routes', 'route_stops', 'vehicle_assignments', 'learner_transport', 'trips'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON vehicles TO figbloom_app;
GRANT UPDATE (plate_number, make_model, capacity, active) ON vehicles TO figbloom_app;
GRANT SELECT, INSERT ON transport_routes TO figbloom_app;
GRANT UPDATE (name, description, active) ON transport_routes TO figbloom_app;
GRANT SELECT, INSERT, DELETE ON route_stops TO figbloom_app;
GRANT UPDATE (name, sequence, lat, lng) ON route_stops TO figbloom_app;
GRANT SELECT, INSERT ON vehicle_assignments TO figbloom_app;
GRANT UPDATE (route_id, active) ON vehicle_assignments TO figbloom_app;
GRANT SELECT, INSERT, DELETE ON learner_transport TO figbloom_app;
GRANT UPDATE (route_id, stop_id) ON learner_transport TO figbloom_app;
GRANT SELECT, INSERT ON trips TO figbloom_app;
GRANT UPDATE (status, ended_at, route_id) ON trips TO figbloom_app;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON vehicles FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON transport_routes FROM figbloom_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON route_stops FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON vehicle_assignments FROM figbloom_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON learner_transport FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON trips FROM figbloom_app;
