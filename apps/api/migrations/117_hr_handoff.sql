-- 117: the "HR & Payroll" hand-off on the API (docs/HR-HANDOFF.md, slice H1). Forward-only; 001-116 untouched.
--
-- A port of the live Supabase feature (CHANGELOG.md, "HR and Payroll: connect page, Request Figbloom HR, open HR in a new
-- tab", #355: the open-hr function, 20261105700000_platform_hr_handoff.sql and 20261124100000_hr_request.sql), with the API's
-- stricter rule for organisation administrators (only through a delegation, HR-HANDOFF.md risk R5).
--
--   1. The permission resource.hr.handoff: the school's administrators hold it (role catalogue), and so does anyone holding the
--      Fees area (src/modules/rbac/authorize.ts, HR_HANDOFF_IMPLIED; not added to FEES_AREA_IMPLIED). Platform super
--      administrators hold every catalogued permission, but the routes refuse them in code: HR has no account for them.
--   2. platform_school_links (108) gains platform_tenant_id, the platform's OWN id for the school (Supabase:
--      platform_links.platform_id). The platform's module and link lookups (GET /tenants/{id}/modules/hr, /links/hr) take that
--      id, not ours. Like the row itself, an operator writes it (docs/MY-HR.md, "Linking a school"); without it the API cannot
--      ask whether HR is there and says "unknown".
--   3. figbloom_app may UPDATE hr_enabled, hr_reason and hr_checked_at of its own school's row (and nothing else on it): the
--      hand-off records the platform's last answer about HR, as open-hr does (platform_record_module_status). That closes
--      MY-HR.md's open point "who writes not_enabled".
--   4. tenants gains hr_requested_at and hr_requested_by: "Request Figbloom HR" (Supabase: the same two columns). tenants stays
--      SELECT-only for figbloom_app; the one write path is hr_record_request() below, which keeps the first request.
--   5. school_audit_events (106) shows the two new audit kinds, hr.handoff.opened and hr.handoff.requested, under "access", as
--      Supabase files them. The function is otherwise unchanged.

-- ---------------------------------------------------------------- 1. the permission
INSERT INTO permissions (code, description) VALUES
  ('resource.hr.handoff', 'HR & Payroll: see whether Figbloom HR is there for the school, ask Figbloom for it, and open it with a one-time sign-in link')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.hr.handoff'),
  -- platform super administrators hold every catalogued permission (the hand-off routes still refuse them)
  ('super_admin', 'resource.hr.handoff')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- 2. the platform's own id for the school
ALTER TABLE platform_school_links
  ADD COLUMN platform_tenant_id text,
  ADD CONSTRAINT platform_school_links_platform_tenant_id_chk
    CHECK (platform_tenant_id IS NULL OR platform_tenant_id ~ '^[A-Za-z0-9_-]{1,128}$');

-- ---------------------------------------------------------------- 3. the platform's last answer about HR
GRANT UPDATE (hr_enabled, hr_reason, hr_checked_at) ON platform_school_links TO figbloom_app;

-- ---------------------------------------------------------------- 4. "Request Figbloom HR"
ALTER TABLE tenants
  ADD COLUMN hr_requested_at timestamptz,
  ADD COLUMN hr_requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- who asked may be gone later (the account deleted), but nobody is recorded without a time
  ADD CONSTRAINT tenants_hr_request_chk CHECK (hr_requested_by IS NULL OR hr_requested_at IS NOT NULL);

-- The one write path to the two columns. No argument: the school is app_current_tenant_id() and the person
-- app_current_user_id(), both set by the API after it authorised the request (the route checks resource.hr.handoff and that
-- the switch is on and HR is not already there). As defence in depth the person must still be an active account, not a
-- platform super administrator, and either an active staff member of the school (school_admin, teacher or staff) or an
-- organisation administrator with a live delegation of the Fees area there; the school must not be suspended. The first
-- request is kept: asking again changes nothing and answers the first one's time (`recorded` false).
CREATE FUNCTION public.hr_record_request()
RETURNS TABLE (requested_at timestamptz, recorded boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_actor uuid := public.app_current_user_id();
  v_rows integer;
  v_at timestamptz;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'no school or account in this request' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor AND u.status = 'active')
     OR EXISTS (SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin')
     OR NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v_tenant AND t.status <> 'suspended')
     OR NOT (
       EXISTS (SELECT 1 FROM public.school_memberships sm
                WHERE sm.user_id = v_actor AND sm.tenant_id = v_tenant AND sm.archived_at IS NULL
                  AND sm.role IN ('school_admin', 'teacher', 'staff'))
       OR EXISTS (SELECT 1 FROM public.org_admin_school_delegations d
                   WHERE d.delegate_user_id = v_actor AND d.tenant_id = v_tenant AND d.revoked_at IS NULL
                     AND d.permission_code = 'area.fees')
     ) THEN
    RAISE EXCEPTION 'not allowed to ask for HR for this school' USING ERRCODE = '42501';
  END IF;

  UPDATE public.tenants t
     SET hr_requested_at = pg_catalog.now(), hr_requested_by = v_actor
   WHERE t.id = v_tenant AND t.hr_requested_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT t.hr_requested_at INTO v_at FROM public.tenants t WHERE t.id = v_tenant;

  requested_at := v_at;
  recorded := v_rows > 0;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION public.hr_record_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_record_request() TO figbloom_app;

-- ---------------------------------------------------------------- 5. the school's audit log files the hand-off under access
-- 106's function, re-created with one added line (marked "117"); everything else is as 106 wrote it.
CREATE OR REPLACE FUNCTION public.school_audit_events(
  p_category text,
  p_since timestamptz,
  p_search text,
  p_before_at timestamptz,
  p_before_id uuid,
  p_limit integer
)
RETURNS TABLE (id uuid, occurred_at_text text, event_type text, category text, actor_user_id uuid, actor_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_actor uuid := public.app_current_user_id();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 201);
  v_search text := lower(nullif(btrim(coalesce(p_search, '')), ''));
BEGIN
  -- The API checks the permission first; the database still needs a school and an account, and refuses without them.
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'no school or account in this request' USING ERRCODE = '42501';
  END IF;
  IF (p_before_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'cursor needs both a time and an id' USING ERRCODE = '22023';
  END IF;
  IF p_category IS NOT NULL AND p_category NOT IN
     ('provisioning', 'access', 'academic', 'financial', 'health', 'transport', 'communication', 'operations') THEN
    RAISE EXCEPTION 'unknown category' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id,
           to_char(x.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           x.event_type,
           x.cat,
           x.actor_user_id,
           u.full_name
      FROM (
        SELECT e.id, e.occurred_at, e.event_type, e.actor_user_id,
               CASE
                 -- two administrators' actions on an account belong to the log, though they are written under auth.
                 WHEN e.event_type IN ('auth.password.reset_issued', 'auth.mfa.admin_reset') THEN 'access'
                 -- never shown: sign-in and session events, refusals, read events, personal and internal ones
                 WHEN e.event_type ~ '^(auth|family|ai|notifications|identity)\.' THEN NULL
                 WHEN e.event_type ~ '[._](denied|viewed)$' THEN NULL
                 -- platform operators' notes on unmatched M-Pesa callbacks: not a school's own actions
                 WHEN e.event_type ~ '^finance\.unmatched\.' THEN NULL
                 WHEN e.event_type IN ('finance.mpesa.operator_inconclusive', 'communications.chat.started',
                                       'communications.notification_preferences.updated',
                                       'communications.device_token.reclaimed',
                                       'attendance.register.stale_ignored', 'import.learners.preview_expired',
                                       'rbac.org_delegation.legacy_inert', 'rbac.org_delegation.review_required') THEN NULL
                 WHEN e.event_type ~ '^storage\.' AND e.event_type <> 'storage.object.deleted' THEN NULL
                 -- shown, by category (the web console's eight)
                 WHEN e.event_type ~ '^(directory|import)\.' THEN 'provisioning'
                 WHEN e.event_type ~ '^academics\.(year|term|subject|class|teaching_assignment|membership)\.' THEN 'provisioning'
                 WHEN e.event_type ~ '^attendance\.settings\.' THEN 'provisioning'
                 WHEN e.event_type ~ '^rbac\.' THEN 'access'
                 -- invitations (staff and guardian), a member deactivated, a guardian link revoked: written by the database functions
                 WHEN e.event_type ~ '^(account|guardian)\.' THEN 'access'
                 -- 117: the "HR & Payroll" hand-off (opening HR, asking Figbloom for it) is an access event, as on Supabase
                 WHEN e.event_type ~ '^hr\.handoff\.' THEN 'access'
                 WHEN e.event_type ~ '^(academics|curriculum)\.' THEN 'academic'
                 WHEN e.event_type ~ '^reporting\.teacher_report\.' THEN 'academic'
                 WHEN e.event_type ~ '^finance\.' THEN 'financial'
                 WHEN e.event_type ~ '^(health|medication)\.' THEN 'health'
                 WHEN e.event_type ~ '^transport\.' THEN 'transport'
                 WHEN e.event_type ~ '^communications\.visit\.' THEN 'operations'
                 WHEN e.event_type ~ '^communications\.' OR e.event_type = 'admin.manual_notice' THEN 'communication'
                 WHEN e.event_type ~ '^(inventory|activities|attendance|hr|storage|reporting)\.' THEN 'operations'
                 ELSE NULL
               END AS cat
          FROM public.security_audit_events e
         WHERE e.tenant_id = v_tenant
           AND (p_since IS NULL OR e.occurred_at >= p_since)
           AND (p_before_at IS NULL
                OR e.occurred_at < p_before_at
                OR (e.occurred_at = p_before_at AND e.id > p_before_id))
      ) x
      LEFT JOIN public.users u ON u.id = x.actor_user_id
     WHERE x.cat IS NOT NULL
       AND (p_category IS NULL OR x.cat = p_category)
       AND (v_search IS NULL
            OR position(v_search IN lower(coalesce(u.full_name, ''))) > 0
            OR position(v_search IN replace(replace(x.event_type, '_', ' '), '.', ' ')) > 0)
     ORDER BY x.occurred_at DESC, x.id
     LIMIT v_limit;
END
$$;
REVOKE ALL ON FUNCTION public.school_audit_events(text, timestamptz, text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.school_audit_events(text, timestamptz, text, timestamptz, uuid, integer) TO figbloom_app;
