-- 095: Independent audit hardening (forward-only). Closes defects found while re-auditing migrations 089-094:
--   MED-1  MAR rows could be written for any timestamp, for a schedule whose authorization was revoked/expired, or
--          with learner/authorization ids that do not match the schedule (duplicate-dose risk, consent bypass).
--   MED-2  Revoking/declining consent or leaving 'approved' did not stop the schedules of that authorization.
--   LOW-3  Medication incidents could point at another learner's authorization or MAR row.
--   LOW-4  Curriculum import duplicate detection was check-then-insert without a lock (concurrent imports duplicated).
-- No clinical rule is introduced: slots come from the schedule's own times, dates from the authorization's own range.

CREATE FUNCTION public.medication_mar_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sched public.medication_schedules%ROWTYPE;
  v_auth  public.medication_authorizations%ROWTYPE;
  v_tz    text;
  v_local timestamp;
BEGIN
  SELECT * INTO v_sched FROM public.medication_schedules WHERE id = NEW.schedule_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication schedule not found' USING ERRCODE = '23514';
  END IF;
  IF v_sched.learner_id IS DISTINCT FROM NEW.learner_id OR v_sched.authorization_id IS DISTINCT FROM NEW.authorization_id THEN
    RAISE EXCEPTION 'Administration record must match its schedule learner and authorization' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_auth FROM public.medication_authorizations WHERE id = NEW.authorization_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication authorization not found' USING ERRCODE = '23514';
  END IF;

  SELECT t.timezone INTO v_tz FROM public.tenants t WHERE t.id = NEW.tenant_id;
  v_local := NEW.scheduled_for AT TIME ZONE COALESCE(v_tz, 'Africa/Nairobi');

  -- the slot must be one of the schedule's own times (to the minute) so one dose cannot be recorded twice under
  -- slightly different timestamps
  IF v_local <> date_trunc('minute', v_local) OR NOT (to_char(v_local, 'HH24:MI') = ANY (v_sched.schedule_times)) THEN
    RAISE EXCEPTION 'scheduled_for must be one of the schedule times (school time zone)' USING ERRCODE = '23514';
  END IF;
  IF v_local::date < v_auth.start_date OR v_local::date > v_auth.end_date THEN
    RAISE EXCEPTION 'scheduled_for is outside the authorization date range' USING ERRCODE = '23514';
  END IF;

  -- a dose can only be recorded as given while the authorization is approved with consent still granted
  IF NEW.outcome IN ('administered', 'delayed')
     AND NOT (v_sched.active AND v_auth.status = 'approved' AND v_auth.guardian_consent_status = 'granted') THEN
    RAISE EXCEPTION 'Medication cannot be recorded as administered without an approved authorization with granted guardian consent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.medication_mar_guard() FROM PUBLIC;

CREATE TRIGGER medication_mar_guard BEFORE INSERT ON medication_administration_records
  FOR EACH ROW EXECUTE FUNCTION public.medication_mar_guard();

CREATE FUNCTION public.medication_authorizations_stop_schedules() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (OLD.status = 'approved' AND NEW.status <> 'approved')
     OR (OLD.guardian_consent_status = 'granted' AND NEW.guardian_consent_status <> 'granted') THEN
    UPDATE public.medication_schedules
       SET active = false,
           cancelled_at = now(),
           cancelled_reason = left('authorization ' || NEW.status || ', consent ' || NEW.guardian_consent_status, 500)
     WHERE authorization_id = NEW.id AND tenant_id = NEW.tenant_id AND active;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.medication_authorizations_stop_schedules() FROM PUBLIC;

CREATE TRIGGER medication_authorizations_stop_schedules AFTER UPDATE ON medication_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.medication_authorizations_stop_schedules();

CREATE FUNCTION public.medication_incidents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.authorization_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.medication_authorizations a
        WHERE a.id = NEW.authorization_id AND a.tenant_id = NEW.tenant_id AND a.learner_id = NEW.learner_id) THEN
    RAISE EXCEPTION 'Incident authorization must belong to the same learner' USING ERRCODE = '23514';
  END IF;
  IF NEW.mar_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.medication_administration_records m
        WHERE m.id = NEW.mar_id AND m.tenant_id = NEW.tenant_id AND m.learner_id = NEW.learner_id) THEN
    RAISE EXCEPTION 'Incident administration record must belong to the same learner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.medication_incidents_guard() FROM PUBLIC;

CREATE TRIGGER medication_incidents_guard BEFORE INSERT ON medication_incidents
  FOR EACH ROW EXECUTE FUNCTION public.medication_incidents_guard();

-- Curriculum import: serialise concurrent imports of the same (kind, code) so duplicate detection cannot race.
CREATE OR REPLACE FUNCTION public.curriculum_catalogue_import_entry(
  p_batch_id uuid,
  p_provenance_id uuid,
  p_entry_kind text,
  p_code text,
  p_title text,
  p_body text,
  p_education_level text,
  p_grade_band text,
  p_pathway text,
  p_parent_code text,
  p_source_organisation text,
  p_source_title text,
  p_source_uri text,
  p_publication_or_version text,
  p_retrieved_at date,
  p_known_limitations text
) RETURNS TABLE (id uuid, duplicated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_existing uuid;
  v_new_id uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('curriculum-import:' || v_tenant::text || ':' || p_entry_kind || ':' || lower(btrim(p_code)), 0));
  SELECT e.id INTO v_existing
    FROM public.curriculum_reference_entries e
   WHERE e.tenant_id = v_tenant
     AND e.entry_kind = p_entry_kind
     AND lower(e.code) = lower(btrim(p_code))
     AND e.verification_status <> 'superseded'
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT v_existing, true;
    RETURN;
  END IF;

  INSERT INTO public.curriculum_reference_entries (
    tenant_id, provenance_id, import_batch_id, entry_kind, code, title, body,
    education_level, grade_band, pathway, parent_code, source_organisation,
    source_title, source_uri, publication_or_version, retrieved_at,
    verification_status, known_limitations, version_number
  ) VALUES (
    v_tenant, p_provenance_id, p_batch_id, p_entry_kind, btrim(p_code), btrim(p_title), p_body,
    p_education_level, p_grade_band, p_pathway, p_parent_code, btrim(p_source_organisation),
    btrim(p_source_title), p_source_uri, p_publication_or_version, p_retrieved_at,
    'imported', p_known_limitations, 1
  )
  RETURNING curriculum_reference_entries.id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, false;
END;
$$;
