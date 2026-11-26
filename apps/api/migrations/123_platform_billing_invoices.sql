-- Platform billing slice S6b (D3, apps/api/docs/PLATFORM-CONSOLE.md).
-- Figbloom invoices are separate from school fee invoices. Staff record them and reconcile payment by hand;
-- no overdue invoice changes a school's access status.
--
-- This is an API-owned copy of the live platform_invoices contract. Runtime access is through SECURITY DEFINER
-- functions only; every function re-checks the current super administrator from app.user_id.
-- The API table starts empty; the old Supabase rows are not visible to this database migration.
-- Forward-only.

CREATE TABLE public.platform_invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid')),
  paid_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_invoices_due_date_id_idx ON public.platform_invoices (due_date, id);
CREATE INDEX platform_invoices_tenant_id_idx ON public.platform_invoices (tenant_id);

ALTER TABLE public.platform_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_invoices_owner ON public.platform_invoices FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relname = 'platform_invoices'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = 'public' AND c.relname = 'platform_invoices'));
REVOKE ALL ON public.platform_invoices FROM PUBLIC, figbloom_app, figbloom_worker;

CREATE FUNCTION public.platform_billing_invoices_list(p_before_due date, p_before_id uuid, p_limit integer)
RETURNS TABLE (
  invoice_id uuid,
  tenant_id uuid,
  tenant_name text,
  amount_cents integer,
  due_date_text text,
  status text,
  paid_at_text text,
  created_at_text text
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
  IF (p_before_due IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'invoice cursor is incomplete' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT i.id,
           i.tenant_id,
           t.name,
           i.amount_cents,
           to_char(i.due_date, 'YYYY-MM-DD'),
           i.status,
           CASE WHEN i.paid_at IS NULL THEN NULL ELSE to_char(i.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
           to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM public.platform_invoices i
      JOIN public.tenants t ON t.id = i.tenant_id
     WHERE p_before_due IS NULL OR (i.due_date, i.id) > (p_before_due, p_before_id)
     ORDER BY i.due_date, i.id
     LIMIT v_limit;
END
$$;
REVOKE ALL ON FUNCTION public.platform_billing_invoices_list(date, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_billing_invoices_list(date, uuid, integer) TO figbloom_app;

CREATE FUNCTION public.platform_billing_invoice_create(p_tenant_id uuid, p_amount_cents integer, p_due_date date)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_invoice_id uuid;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_tenant_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_due_date IS NULL THEN
    RAISE EXCEPTION 'invalid platform invoice' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
    RAISE EXCEPTION 'school not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.platform_invoices (tenant_id, amount_cents, due_date)
  VALUES (p_tenant_id, p_amount_cents, p_due_date)
  RETURNING id INTO v_invoice_id;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'platform.billing.invoice.created',
          jsonb_build_object('invoiceId', v_invoice_id, 'tenantId', p_tenant_id,
                             'amountCents', p_amount_cents, 'dueDate', p_due_date));
  RETURN v_invoice_id;
END
$$;
REVOKE ALL ON FUNCTION public.platform_billing_invoice_create(uuid, integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_billing_invoice_create(uuid, integer, date) TO figbloom_app;

CREATE FUNCTION public.platform_billing_invoice_mark_paid(p_invoice_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_invoice public.platform_invoices%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'invoice id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice FROM public.platform_invoices i WHERE i.id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invoice.status = 'paid' THEN
    RETURN false;
  END IF;

  UPDATE public.platform_invoices SET status = 'paid', paid_at = now() WHERE id = p_invoice_id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'platform.billing.invoice.paid',
          jsonb_build_object('invoiceId', v_invoice.id, 'tenantId', v_invoice.tenant_id,
                             'amountCents', v_invoice.amount_cents, 'paidAt', now()));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.platform_billing_invoice_mark_paid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_billing_invoice_mark_paid(uuid) TO figbloom_app;
