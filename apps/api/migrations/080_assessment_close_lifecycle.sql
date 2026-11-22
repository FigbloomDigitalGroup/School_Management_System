-- Assessment close lifecycle. Forward-only.
-- Align numeric assessments with CBE: draft → published → closed only (no draft→closed).

CREATE OR REPLACE FUNCTION public.assessments_status_forward_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'A published assessment cannot return to draft' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
    RAISE EXCEPTION 'A closed assessment stays closed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'closed' THEN
    RAISE EXCEPTION 'A draft assessment must be published before it can be closed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
