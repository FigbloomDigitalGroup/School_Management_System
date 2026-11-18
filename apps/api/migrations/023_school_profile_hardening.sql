-- Phase 3 final-audit remediation (P3-AUDIT-004, P3-AUDIT-005). Forward-only: 016 is not edited.
--
-- P3-AUDIT-004  The tenant timezone was only length-checked, so "Mars/Base" could be stored and
--               every later `AT TIME ZONE tenants.timezone` (school today, register sessions) would
--               fail for that school. The audited identity function now accepts only a zone that
--               PostgreSQL itself knows (pg_timezone_names) and stores its canonical spelling.
--               Same rule as the TypeScript pre-check; the database is the authority.
--
-- P3-AUDIT-005  logo_object_key was a client-chosen storage key (the defect class migration 021 closed
--               for documents). No storage integration exists, so no object was ever stored under
--               any value in this column. Existing values are cleared and the column is constrained
--               to the same server-key shape as directory_documents (obj/<tenant uuid>/<64 hex>).
--               The API no longer accepts the field; a future storage integration will assign it.
--
-- directory_update_tenant_identity keeps its signature, SECURITY DEFINER, pinned search_path and
-- grants (CREATE OR REPLACE preserves privileges); the body below is the only change.

CREATE OR REPLACE FUNCTION public.directory_update_tenant_identity(
  p_name text,
  p_timezone text
) RETURNS TABLE (id uuid, name text, slug text, status text, timezone text, organization_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_id uuid;
  v_name text;
  v_slug text;
  v_status text;
  v_timezone text;
  v_org uuid;
  v_zone text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR char_length(trim(p_name)) < 1 OR char_length(trim(p_name)) > 200 THEN
    RAISE EXCEPTION 'invalid school name' USING ERRCODE = '22023';
  END IF;
  IF p_timezone IS NULL OR char_length(trim(p_timezone)) < 1 OR char_length(trim(p_timezone)) > 64 THEN
    RAISE EXCEPTION 'invalid timezone' USING ERRCODE = '22023';
  END IF;

  -- Exact spelling wins; otherwise a case-insensitive match is stored in its canonical form.
  SELECT z.name INTO v_zone
    FROM pg_catalog.pg_timezone_names z
   WHERE lower(z.name) = lower(trim(p_timezone))
   ORDER BY (z.name = trim(p_timezone)) DESC
   LIMIT 1;
  IF v_zone IS NULL THEN
    RAISE EXCEPTION 'invalid timezone' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tenants t
     SET name = trim(p_name),
         timezone = v_zone
   WHERE t.id = v_tenant
   RETURNING t.id, t.name, t.slug, t.status, t.timezone, t.organization_id
     INTO v_id, v_name, v_slug, v_status, v_timezone, v_org;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'P0002';
  END IF;

  id := v_id;
  name := v_name;
  slug := v_slug;
  status := v_status;
  timezone := v_timezone;
  organization_id := v_org;
  RETURN NEXT;
END;
$$;

-- No object was ever stored for any existing value; clear them, then constrain the column.
UPDATE public.school_profiles
   SET logo_object_key = NULL
 WHERE logo_object_key IS NOT NULL
   AND NOT (
     logo_object_key ~ '^obj/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
     AND split_part(logo_object_key, '/', 2) = tenant_id::text
   );

ALTER TABLE public.school_profiles
  ADD CONSTRAINT school_profiles_logo_object_key_shape CHECK (
    logo_object_key IS NULL
    OR (
      logo_object_key ~ '^obj/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
      AND split_part(logo_object_key, '/', 2) = tenant_id::text
    )
  );
