-- Platform billing slice S6a (apps/api/docs/PLATFORM-CONSOLE.md, D3).
-- Figbloom's subscription terms and its plan price list are platform-owned. They are not school fees, and overdue invoices
-- do not suspend a school. No billing columns are added to tenants.
--
-- The old Supabase schema defaults every new school to the standard plan and stores its current status on tenants.
-- Preserve those known defaults in the new owner-only table. Price values are deliberately not seeded: the legacy values
-- in 20260914000000_platform_ops_tables.sql are documented placeholders, not approved prices.
--
-- Runtime access is through SECURITY DEFINER functions only. Both owner-only tables have forced RLS and no runtime grants;
-- each callable function re-checks the acting super administrator from app.user_id.
-- Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('platform.billing.read', 'Platform: read school subscription terms and plan prices'),
  ('platform.billing.manage', 'Platform: manage school subscription terms, plan prices, and invoices')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('super_admin', 'platform.billing.read'),
  ('super_admin', 'platform.billing.manage')
ON CONFLICT (role, permission_code) DO NOTHING;

CREATE TABLE public.plan_pricing (
  plan        text PRIMARY KEY CHECK (plan IN ('standard', 'institution', 'county')),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.platform_subscriptions (
  tenant_id            uuid PRIMARY KEY REFERENCES public.tenants (id) ON DELETE CASCADE,
  plan                 text NOT NULL CHECK (plan IN ('standard', 'institution', 'county')),
  status               text NOT NULL CHECK (status IN ('active', 'trial', 'onboarding', 'overdue', 'suspended', 'setup_stalled')),
  price_cents_override integer CHECK (price_cents_override >= 0),
  trial_ends_at        timestamptz,
  renews_on            date,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.plan_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_pricing FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_pricing_owner ON public.plan_pricing FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relname = 'plan_pricing'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = 'public' AND c.relname = 'plan_pricing'));
ALTER TABLE public.platform_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_subscriptions_owner ON public.platform_subscriptions FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relname = 'platform_subscriptions'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = 'public' AND c.relname = 'platform_subscriptions'));
REVOKE ALL ON public.plan_pricing, public.platform_subscriptions FROM PUBLIC, figbloom_app, figbloom_worker;

-- Preserve the legacy default plan and each school's current status without importing unverified money values.
INSERT INTO public.platform_subscriptions (tenant_id, plan, status)
SELECT t.id, 'standard', t.status
  FROM public.tenants t
ON CONFLICT (tenant_id) DO NOTHING;

-- Keep the same default for schools provisioned after this migration.
CREATE FUNCTION public.platform_subscription_seed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.platform_subscriptions (tenant_id, plan, status)
  VALUES (NEW.id, 'standard', NEW.status);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.platform_subscription_seed() FROM PUBLIC, figbloom_app, figbloom_worker;
CREATE TRIGGER platform_subscriptions_seed_after_tenant_insert
AFTER INSERT ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.platform_subscription_seed();

-- Super-admin only, all schools; keyset by the school's C-collated name and id. The caller supplies only an anchor id.
CREATE FUNCTION public.platform_billing_subscriptions_list(p_before_id uuid, p_limit integer)
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  tenant_slug text,
  plan text,
  status text,
  price_cents_override integer,
  trial_ends_at_text text,
  renews_on_text text,
  price_cents integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 201);
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT t.id,
           t.name,
           t.slug,
           s.plan,
           s.status,
           s.price_cents_override,
           CASE WHEN s.trial_ends_at IS NULL THEN NULL ELSE to_char(s.trial_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
           CASE WHEN s.renews_on IS NULL THEN NULL ELSE to_char(s.renews_on, 'YYYY-MM-DD') END,
           COALESCE(s.price_cents_override, p.price_cents, 0)
      FROM public.tenants t
      JOIN public.platform_subscriptions s ON s.tenant_id = t.id
      LEFT JOIN public.plan_pricing p ON p.plan = s.plan
     WHERE p_before_id IS NULL
        OR (t.name COLLATE "C", t.id) > (
          SELECT ta.name COLLATE "C", ta.id FROM public.tenants ta WHERE ta.id = p_before_id
        )
     ORDER BY t.name COLLATE "C", t.id
     LIMIT v_limit;
END
$$;
REVOKE ALL ON FUNCTION public.platform_billing_subscriptions_list(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_billing_subscriptions_list(uuid, integer) TO figbloom_app;

CREATE FUNCTION public.platform_billing_plan_prices()
RETURNS TABLE (plan text, price_cents integer, updated_at_text text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT p.plan, p.price_cents,
           to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM public.plan_pricing p
     ORDER BY p.plan COLLATE "C";
END
$$;
REVOKE ALL ON FUNCTION public.platform_billing_plan_prices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_billing_plan_prices() TO figbloom_app;

-- A complete assignment; all money changes and subscription term changes are written to the immutable security audit log.
CREATE FUNCTION public.platform_billing_subscription_update(
  p_tenant_id uuid,
  p_plan text,
  p_status text,
  p_price_cents_override integer,
  p_trial_ends_at timestamptz,
  p_renews_on date
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_old public.platform_subscriptions%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('standard', 'institution', 'county')
     OR p_status IS NULL OR p_status NOT IN ('active', 'trial', 'onboarding', 'overdue', 'suspended', 'setup_stalled')
     OR p_price_cents_override < 0 THEN
    RAISE EXCEPTION 'invalid subscription' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM public.platform_subscriptions s WHERE s.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.plan = p_plan
     AND v_old.status = p_status
     AND v_old.price_cents_override IS NOT DISTINCT FROM p_price_cents_override
     AND v_old.trial_ends_at IS NOT DISTINCT FROM p_trial_ends_at
     AND v_old.renews_on IS NOT DISTINCT FROM p_renews_on THEN
    RETURN false;
  END IF;

  UPDATE public.platform_subscriptions
     SET plan = p_plan,
         status = p_status,
         price_cents_override = p_price_cents_override,
         trial_ends_at = p_trial_ends_at,
         renews_on = p_renews_on,
         updated_at = now()
   WHERE tenant_id = p_tenant_id;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (
    v_actor,
    NULL,
    'platform.billing.subscription.updated',
    jsonb_build_object(
      'tenantId', p_tenant_id,
      'before', jsonb_build_object('plan', v_old.plan, 'status', v_old.status, 'priceCentsOverride', v_old.price_cents_override, 'trialEndsAt', v_old.trial_ends_at, 'renewsOn', v_old.renews_on),
      'after', jsonb_build_object('plan', p_plan, 'status', p_status, 'priceCentsOverride', p_price_cents_override, 'trialEndsAt', p_trial_ends_at, 'renewsOn', p_renews_on)
    )
  );
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.platform_billing_subscription_update(uuid, text, text, integer, timestamptz, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_billing_subscription_update(uuid, text, text, integer, timestamptz, date) TO figbloom_app;

CREATE FUNCTION public.platform_billing_plan_price_set(p_plan text, p_price_cents integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_old integer;
  v_found boolean;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('standard', 'institution', 'county')
     OR p_price_cents IS NULL OR p_price_cents < 0 THEN
    RAISE EXCEPTION 'invalid plan price' USING ERRCODE = '22023';
  END IF;

  -- A missing row is not lockable with SELECT ... FOR UPDATE. Serialize first-time writes per plan
  -- so the immutable audit event has the actual immediately preceding value.
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-plan-price:' || p_plan, 0));
  SELECT p.price_cents INTO v_old FROM public.plan_pricing p WHERE p.plan = p_plan FOR UPDATE;
  v_found := FOUND;
  IF v_found AND v_old = p_price_cents THEN
    RETURN false;
  END IF;

  INSERT INTO public.plan_pricing (plan, price_cents, updated_at)
  VALUES (p_plan, p_price_cents, now())
  ON CONFLICT (plan) DO UPDATE SET price_cents = EXCLUDED.price_cents, updated_at = EXCLUDED.updated_at;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'platform.billing.plan_price.updated',
          jsonb_build_object('plan', p_plan, 'previousPriceCents', CASE WHEN v_found THEN v_old ELSE NULL END, 'priceCents', p_price_cents));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.platform_billing_plan_price_set(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_billing_plan_price_set(text, integer) TO figbloom_app;
