-- Phase 3 — School directory profile foundations (FIG-1575)
-- Forward-only. Directory-owned profile fields; does not own terms/classes/attendance.

INSERT INTO permissions (code, description) VALUES
  ('resource.school_profile.read', 'Read school directory profile for tenant'),
  ('resource.school_profile.write', 'Update school directory profile for tenant')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.school_profile.read'),
  ('school_admin', 'resource.school_profile.write')
ON CONFLICT DO NOTHING;

CREATE TABLE school_profiles (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  county text,
  country text,
  level text,
  institution_type text CHECK (
    institution_type IS NULL OR institution_type IN ('k12', 'higher_ed')
  ),
  contact_email text,
  contact_phone text,
  moe_registration text,
  logo_object_key text,
  accent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT school_profiles_county_len CHECK (county IS NULL OR char_length(county) BETWEEN 1 AND 120),
  CONSTRAINT school_profiles_country_len CHECK (country IS NULL OR char_length(country) BETWEEN 1 AND 120),
  CONSTRAINT school_profiles_level_len CHECK (level IS NULL OR char_length(level) BETWEEN 1 AND 64),
  CONSTRAINT school_profiles_contact_email_len CHECK (
    contact_email IS NULL OR char_length(contact_email) BETWEEN 3 AND 254
  ),
  CONSTRAINT school_profiles_contact_phone_len CHECK (
    contact_phone IS NULL OR char_length(contact_phone) BETWEEN 5 AND 32
  ),
  CONSTRAINT school_profiles_moe_len CHECK (
    moe_registration IS NULL OR char_length(moe_registration) BETWEEN 1 AND 64
  ),
  CONSTRAINT school_profiles_logo_len CHECK (
    logo_object_key IS NULL OR char_length(logo_object_key) BETWEEN 1 AND 512
  ),
  CONSTRAINT school_profiles_accent_len CHECK (
    accent IS NULL OR char_length(accent) BETWEEN 1 AND 32
  )
);

ALTER TABLE school_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY school_profiles_tenant ON school_profiles
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY school_profiles_owner ON school_profiles
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'school_profiles'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'school_profiles'
  ));

GRANT SELECT, INSERT, UPDATE ON school_profiles TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON school_profiles FROM figbloom_app;

-- Audited tenant identity update (name/timezone). tenants stay SELECT-only for figbloom_app.
CREATE FUNCTION public.directory_update_tenant_identity(
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

  UPDATE public.tenants t
     SET name = trim(p_name),
         timezone = trim(p_timezone)
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

REVOKE ALL ON FUNCTION public.directory_update_tenant_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.directory_update_tenant_identity(text, text) TO figbloom_app;
