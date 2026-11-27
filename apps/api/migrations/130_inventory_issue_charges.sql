-- W1.7: connect one lost/damaged learner issue to one fee charge.
-- The charge stays an immutable finance row; the optional relation is inserted with it.
ALTER TABLE public.inventory_issues
  ADD CONSTRAINT inventory_issues_id_tenant_uniq UNIQUE (id, tenant_id);

ALTER TABLE public.finance_charges
  ADD COLUMN inventory_issue_id uuid,
  ADD CONSTRAINT finance_charges_inventory_issue_fk
    FOREIGN KEY (inventory_issue_id, tenant_id)
    REFERENCES public.inventory_issues (id, tenant_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX finance_charges_one_per_inventory_issue_uidx
  ON public.finance_charges (tenant_id, inventory_issue_id)
  WHERE inventory_issue_id IS NOT NULL;

-- The runtime can only write a link at charge creation, and the linked issue must be lost/damaged
-- and belong to the learner billed on that invoice. The API checks this too for useful errors.
CREATE FUNCTION public.finance_charges_inventory_issue_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_issue public.inventory_issues%ROWTYPE;
  v_learner uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.inventory_issue_id IS DISTINCT FROM OLD.inventory_issue_id THEN
      RAISE EXCEPTION 'an inventory issue link cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.inventory_issue_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_issue FROM public.inventory_issues
   WHERE id = NEW.inventory_issue_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR v_issue.status NOT IN ('lost', 'damaged') OR v_issue.learner_id IS NULL THEN
    RAISE EXCEPTION 'only a lost or damaged learner issue can be charged' USING ERRCODE = '23514';
  END IF;
  SELECT learner_id INTO v_learner FROM public.finance_invoices
   WHERE id = NEW.invoice_id AND tenant_id = NEW.tenant_id;
  IF v_learner IS DISTINCT FROM v_issue.learner_id THEN
    RAISE EXCEPTION 'the invoice learner must match the inventory issue learner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.finance_charges_inventory_issue_guard() FROM PUBLIC, figbloom_app;
CREATE TRIGGER finance_charges_inventory_issue_guard
  BEFORE INSERT OR UPDATE ON public.finance_charges
  FOR EACH ROW EXECUTE FUNCTION public.finance_charges_inventory_issue_guard();
