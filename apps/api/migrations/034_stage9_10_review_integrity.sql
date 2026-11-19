-- Stage 9/10 independent review fixes (Claude, 2026-11-19). Forward-only.
-- Migrations 029–033 are not edited. No table is created here.
--
--   R10-2  early_sign_out_collectors referenced early_sign_outs by id only, so a
--          collector row could name another school's sign-out. Add the composite
--          (sign_out_id, tenant_id) foreign key used everywhere else.
--   R10-3  Early sign-out voiding was not final at the database: the runtime role
--          could clear voided_at (un-void), move the void time, or rewrite or pre-fill
--          void_reason. A sign-out may only go live -> voided, once; void_reason may
--          only be set once, on a voided sign-out. FK ON DELETE SET NULL of a user id
--          is still allowed.
--   A9-4   online_exam_attempts allowed any number of in-progress attempts per learner
--          per paper and allowed status to move backwards. One in-progress attempt per
--          learner and paper; status is forward-only (in_progress -> submitted).
--   A9-15  mark_entries row_version was only bumped by application code. Every UPDATE
--          must now advance row_version by exactly one (optimistic concurrency cannot be
--          skipped by a future code path).
--
-- All functions here are invoker functions with a fixed search_path; EXECUTE is
-- revoked from PUBLIC and figbloom_app (trigger functions need no EXECUTE grant).

-- ---------------------------------------------------------------- R10-2
ALTER TABLE early_sign_out_collectors
  ADD CONSTRAINT early_sign_out_collectors_sign_out_tenant_fk
  FOREIGN KEY (sign_out_id, tenant_id)
  REFERENCES early_sign_outs (id, tenant_id)
  ON DELETE RESTRICT;

-- ---------------------------------------------------------------- R10-3
CREATE FUNCTION public.early_sign_outs_void_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at THEN
    -- Only an ON DELETE SET NULL of a referenced user may touch these columns.
    IF NEW.voided_by IS DISTINCT FROM OLD.voided_by AND NEW.voided_by IS NOT NULL THEN
      RAISE EXCEPTION 'An early sign-out void cannot be changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'An early sign-out void is final' USING ERRCODE = '23514';
  END IF;
  -- live -> voided: the time is the database clock, never a back-dated value.
  NEW.voided_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.early_sign_outs_void_once() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.early_sign_outs_void_once() FROM figbloom_app;

CREATE TRIGGER early_sign_outs_void_once
  BEFORE UPDATE ON early_sign_outs
  FOR EACH ROW
  EXECUTE FUNCTION public.early_sign_outs_void_once();

CREATE FUNCTION public.early_sign_out_collectors_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'void_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'void_reason') THEN
    RAISE EXCEPTION 'Collector details cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.void_reason IS DISTINCT FROM OLD.void_reason THEN
    IF OLD.void_reason IS NOT NULL OR NEW.void_reason IS NULL THEN
      RAISE EXCEPTION 'A void reason is final' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.early_sign_outs e
       WHERE e.id = NEW.sign_out_id AND e.tenant_id = NEW.tenant_id AND e.voided_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'A void reason needs a voided sign-out' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.early_sign_out_collectors_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.early_sign_out_collectors_guard() FROM figbloom_app;

CREATE TRIGGER early_sign_out_collectors_guard
  BEFORE UPDATE ON early_sign_out_collectors
  FOR EACH ROW
  EXECUTE FUNCTION public.early_sign_out_collectors_guard();

-- ---------------------------------------------------------------- A9-4
CREATE UNIQUE INDEX online_exam_attempts_one_in_progress_uidx
  ON online_exam_attempts (tenant_id, paper_id, learner_id)
  WHERE status = 'in_progress';

CREATE FUNCTION public.online_exam_attempts_forward_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status = 'submitted' AND (NEW.status, NEW.submitted_at) IS DISTINCT FROM (OLD.status, OLD.submitted_at) THEN
    RAISE EXCEPTION 'A submitted attempt is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.online_exam_attempts_forward_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.online_exam_attempts_forward_only() FROM figbloom_app;

CREATE TRIGGER online_exam_attempts_forward_only
  BEFORE UPDATE ON online_exam_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.online_exam_attempts_forward_only();

-- ---------------------------------------------------------------- A9-15
CREATE FUNCTION public.mark_entries_version_step() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.row_version IS DISTINCT FROM OLD.row_version + 1 THEN
    RAISE EXCEPTION 'A mark update must advance row_version by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_entries_version_step() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_entries_version_step() FROM figbloom_app;

CREATE TRIGGER mark_entries_version_step
  BEFORE UPDATE ON mark_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.mark_entries_version_step();
