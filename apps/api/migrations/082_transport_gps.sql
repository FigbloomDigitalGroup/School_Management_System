-- WS-4: Transport GPS (N-08) — vehicle_locations + privacy retention housekeeping.
-- Forward-only. Preserves all migrations 001–081.

ALTER TABLE trips
  ADD CONSTRAINT trips_id_tenant_uniq UNIQUE (id, tenant_id);

CREATE TABLE vehicle_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL,
  trip_id uuid,
  recorded_by uuid REFERENCES users (id) ON DELETE SET NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  speed_kmh double precision,
  heading double precision,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CONSTRAINT vehicle_locations_vehicle_fk FOREIGN KEY (vehicle_id, tenant_id)
    REFERENCES vehicles (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT vehicle_locations_trip_fk FOREIGN KEY (trip_id, tenant_id)
    REFERENCES trips (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT vehicle_locations_lat_chk CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT vehicle_locations_lng_chk CHECK (lng BETWEEN -180 AND 180),
  CONSTRAINT vehicle_locations_speed_chk CHECK (speed_kmh IS NULL OR (speed_kmh >= 0 AND speed_kmh <= 250)),
  CONSTRAINT vehicle_locations_heading_chk CHECK (heading IS NULL OR (heading >= 0 AND heading <= 360))
);

CREATE INDEX vehicle_locations_vehicle_time_idx
  ON vehicle_locations (tenant_id, vehicle_id, recorded_at DESC);

CREATE INDEX vehicle_locations_expires_idx
  ON vehicle_locations (expires_at);

ALTER TABLE vehicle_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_locations FORCE ROW LEVEL SECURITY;

CREATE POLICY vehicle_locations_tenant ON vehicle_locations
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY vehicle_locations_owner ON vehicle_locations
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vehicle_locations'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vehicle_locations'
  ));

GRANT SELECT, INSERT ON vehicle_locations TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON vehicle_locations FROM figbloom_app;
REVOKE ALL ON vehicle_locations FROM figbloom_worker;

-- Privacy retention helper callable by figbloom_worker (bounded 1,000-row batch).
CREATE FUNCTION public.worker_prune_vehicle_locations(p_limit integer DEFAULT 1000) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF session_user <> 'figbloom_worker' THEN
    RAISE EXCEPTION 'worker_prune_vehicle_locations requires figbloom_worker' USING ERRCODE = '42501';
  END IF;
  WITH doomed AS (
    SELECT id FROM public.vehicle_locations
    WHERE expires_at < now()
    ORDER BY expires_at ASC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 1000))
  )
  DELETE FROM public.vehicle_locations v
  USING doomed d
  WHERE v.id = d.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.worker_prune_vehicle_locations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.worker_prune_vehicle_locations(integer) TO figbloom_worker;
