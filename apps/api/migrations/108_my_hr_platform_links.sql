-- My HR (docs/MY-HR.md): what the API knows about a school's standing with the Figbloom platform.
--
-- GET /v1/tenants/{t}/me/hr/status mirrors the Supabase rule my_hr_status() (20261105710000). That rule reads two things
-- the API did not have:
--   - whether the platform knows the school (Supabase: platform_links, kind 'tenant')   -> the row exists: 'not_linked' when not
--   - whether the platform said, in the last hour, that HR is not on for it (Supabase: platform_module_status, 'hr')
--                                                                                       -> 'not_enabled'
-- One table holds both, one row per school. It is the smallest thing that does the job and it decides nothing about who
-- registers schools with the platform (open question Q1 in PLATFORM-CONSOLE.md): nothing in the API writes it. A row is added
-- by an operator, as the migrator (docs/MY-HR.md, "Linking a school"), or by whichever slice later owns registration or the
-- HR hand-off, which will add the write grant it needs in its own migration.
--
-- Forward-only. Adds one table; changes nothing that exists.
--
-- Standing rule for tenant tables (TENANT-ISOLATION.md): tenant_id, ENABLE + FORCE row security, one FOR ALL policy for
-- figbloom_app on app_current_tenant_id(), the owner-only policy, minimal grants. figbloom_app may only SELECT.

CREATE TABLE platform_school_links (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  -- the school is known to the platform from this moment
  registered_at timestamptz NOT NULL DEFAULT now(),
  -- the platform's last answer about HR for this school: NULL = never asked, true = on, false = not on
  hr_enabled    boolean,
  -- the platform's refusal code when hr_enabled is false (target_not_enabled, target_not_linked, target_no_handoff_url)
  hr_reason     text,
  hr_checked_at timestamptz,
  CONSTRAINT platform_school_links_hr_reason_chk CHECK (hr_reason IS NULL OR length(hr_reason) <= 64),
  CONSTRAINT platform_school_links_hr_answer_chk CHECK ((hr_enabled IS NULL) = (hr_checked_at IS NULL))
);

ALTER TABLE platform_school_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_school_links FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_school_links_tenant ON platform_school_links
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY platform_school_links_owner ON platform_school_links
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'platform_school_links'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'platform_school_links'
  ));

GRANT SELECT ON platform_school_links TO figbloom_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON platform_school_links FROM figbloom_app;
