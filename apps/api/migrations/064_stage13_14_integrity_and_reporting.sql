-- Stage 13–14 integrity constraints, leave overlap serialization, composite FK fixes, and reporting indexes (S13-02..S13-10, S13-13, S14-6). Forward-only.
--
-- 1) S13-13: Disallow returned_condition when an inventory issue is closed as 'lost', and prevent
--    retiring an inventory item while it has open ('out') issues.
-- 2) S13-07: Serialize concurrent leave_requests inserts/updates per (tenant_id, staff_user_id)
--    inside leave_requests_no_overlap() using pg_advisory_xact_lock so concurrent overlapping leave
--    requests cannot race past the EXISTS check under READ COMMITTED.
-- 3) S13-09 & S13-10: Fix composite ON DELETE SET NULL foreign keys on vehicle_assignments,
--    learner_transport, and trips to use column-specific ON DELETE SET NULL (<nullable_col>),
--    enforce composite (stop_id, route_id, tenant_id) consistency on learner_transport, add
--    trips_one_active_per_driver, and enforce trip status/ended_at consistency.
-- 4) S14-6: Add reporting indexes on attendance(tenant_id, taken_on),
--    attendance_afternoon(tenant_id, taken_on), finance_invoices(tenant_id, term_id) WHERE voided_at IS NULL,
--    and finance_payments(tenant_id, status).

-- ---------------------------------------------------------------------------
-- 1. S13-13: Inventory issue & item retirement guards
-- ---------------------------------------------------------------------------
ALTER TABLE public.inventory_issues
  ADD CONSTRAINT inventory_issues_lost_no_condition_chk CHECK (
    status <> 'lost' OR returned_condition IS NULL
  );

CREATE OR REPLACE FUNCTION public.inventory_items_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'An item cannot be moved to another school' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.inventory_issues i
       WHERE i.tenant_id = NEW.tenant_id
         AND i.item_id = NEW.id
         AND i.status = 'out'
    ) THEN
      RAISE EXCEPTION 'Cannot retire an inventory item while it has open issues' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.asset_tag := nullif(btrim(coalesce(NEW.asset_tag, '')), '');
  NEW.location := nullif(btrim(coalesce(NEW.location, '')), '');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_items_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inventory_items_stamp() FROM figbloom_app;

-- ---------------------------------------------------------------------------
-- 2. S13-07: Serialize concurrent leave overlap checks per (tenant_id, staff_user_id)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leave_requests_no_overlap() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('pending', 'approved') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(NEW.tenant_id::text),
      pg_catalog.hashtext(NEW.staff_user_id::text)
    );
    IF EXISTS (
      SELECT 1 FROM public.leave_requests r
       WHERE r.tenant_id = NEW.tenant_id
         AND r.staff_user_id = NEW.staff_user_id
         AND r.id IS DISTINCT FROM NEW.id
         AND r.status IN ('pending', 'approved')
         AND daterange(r.start_on, r.end_on, '[]') && daterange(NEW.start_on, NEW.end_on, '[]')
    ) THEN
      RAISE EXCEPTION 'Leave dates overlap an existing request' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.leave_requests_no_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.leave_requests_no_overlap() FROM figbloom_app;

-- ---------------------------------------------------------------------------
-- 3. S13-09 & S13-10: Transport composite FKs & trip invariants
-- ---------------------------------------------------------------------------
ALTER TABLE public.vehicle_assignments DROP CONSTRAINT vehicle_assignments_route_fk;
ALTER TABLE public.vehicle_assignments
  ADD CONSTRAINT vehicle_assignments_route_fk
  FOREIGN KEY (route_id, tenant_id) REFERENCES public.transport_routes (id, tenant_id)
  ON DELETE SET NULL (route_id);

ALTER TABLE public.route_stops
  ADD CONSTRAINT route_stops_id_route_tenant_uniq UNIQUE (id, route_id, tenant_id);

ALTER TABLE public.learner_transport DROP CONSTRAINT learner_transport_stop_fk;
ALTER TABLE public.learner_transport
  ADD CONSTRAINT learner_transport_stop_fk
  FOREIGN KEY (stop_id, route_id, tenant_id) REFERENCES public.route_stops (id, route_id, tenant_id)
  ON DELETE SET NULL (stop_id);

ALTER TABLE public.trips DROP CONSTRAINT trips_route_fk;
ALTER TABLE public.trips
  ADD CONSTRAINT trips_route_fk
  FOREIGN KEY (route_id, tenant_id) REFERENCES public.transport_routes (id, tenant_id)
  ON DELETE SET NULL (route_id);

CREATE UNIQUE INDEX trips_one_active_per_driver
  ON public.trips (tenant_id, driver_user_id)
  WHERE status = 'active';

ALTER TABLE public.trips
  ADD CONSTRAINT trips_active_ended_chk CHECK (
    (status = 'active' AND ended_at IS NULL)
    OR (status IN ('completed', 'cancelled') AND ended_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 4. S14-6: Reporting indexes for daily attendance & finance summary
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS attendance_tenant_taken_on_idx
  ON public.attendance (tenant_id, taken_on);

CREATE INDEX IF NOT EXISTS attendance_afternoon_tenant_taken_on_idx
  ON public.attendance_afternoon (tenant_id, taken_on);

CREATE INDEX IF NOT EXISTS finance_invoices_live_term_idx
  ON public.finance_invoices (tenant_id, term_id)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS finance_payments_tenant_status_idx
  ON public.finance_payments (tenant_id, status);
