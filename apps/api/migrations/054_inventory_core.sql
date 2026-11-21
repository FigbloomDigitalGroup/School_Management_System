-- Stage 13: inventory register + issues (legacy 20261027080000). Forward-only.
-- Rebuild: learners / users. Medical stock category included for sick-bay coupling later.

INSERT INTO permissions (code, description) VALUES
  ('resource.inventory.read', 'Read inventory register and issues'),
  ('resource.inventory.write', 'Manage inventory items and issue/return stock')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.inventory.read'),
  ('school_admin', 'resource.inventory.write')
ON CONFLICT DO NOTHING;

CREATE TABLE inventory_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name             text NOT NULL,
  category         text NOT NULL DEFAULT 'other',
  tracking         text NOT NULL DEFAULT 'asset',
  quantity         integer NOT NULL DEFAULT 1,
  asset_tag        text,
  condition        text NOT NULL DEFAULT 'good',
  location         text,
  purchased_on     date,
  unit_cost_cents  bigint,
  notes            text,
  retired_at       timestamptz,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_items_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT inventory_items_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT inventory_items_category_chk CHECK (category IN (
    'textbooks', 'furniture', 'lab_equipment', 'sports', 'ict', 'uniforms',
    'music', 'kitchen', 'stationery', 'tools', 'medical', 'other')),
  CONSTRAINT inventory_items_tracking_chk CHECK (tracking IN ('asset', 'stock')),
  CONSTRAINT inventory_items_quantity_chk CHECK (quantity >= 0),
  CONSTRAINT inventory_items_asset_qty_chk CHECK (tracking = 'stock' OR quantity = 1),
  CONSTRAINT inventory_items_tag_chk CHECK (asset_tag IS NULL OR char_length(asset_tag) BETWEEN 1 AND 80),
  CONSTRAINT inventory_items_condition_chk CHECK (condition IN ('new', 'good', 'fair', 'poor', 'broken')),
  CONSTRAINT inventory_items_location_chk CHECK (location IS NULL OR char_length(location) <= 120),
  CONSTRAINT inventory_items_cost_chk CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  CONSTRAINT inventory_items_notes_chk CHECK (notes IS NULL OR char_length(notes) <= 2000)
);
CREATE UNIQUE INDEX inventory_items_tag_unique ON inventory_items (tenant_id, lower(asset_tag)) WHERE asset_tag IS NOT NULL;
CREATE INDEX inventory_items_tenant_cat_idx ON inventory_items (tenant_id, category, name);

CREATE TABLE inventory_issues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  item_id             uuid NOT NULL,
  learner_id          uuid,
  holder_user_id      uuid REFERENCES users (id) ON DELETE CASCADE,
  quantity            integer NOT NULL DEFAULT 1,
  issued_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  due_on              date,
  condition_out       text,
  status              text NOT NULL DEFAULT 'out',
  returned_condition  text,
  closed_at           timestamptz,
  closed_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  note                text,
  CONSTRAINT inventory_issues_item_fk FOREIGN KEY (item_id, tenant_id) REFERENCES inventory_items (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT inventory_issues_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT inventory_issues_qty_chk CHECK (quantity > 0),
  CONSTRAINT inventory_issues_holder_chk CHECK (num_nonnulls(learner_id, holder_user_id) = 1),
  CONSTRAINT inventory_issues_status_chk CHECK (status IN ('out', 'returned', 'damaged', 'lost')),
  CONSTRAINT inventory_issues_closed_chk CHECK ((status = 'out') = (closed_at IS NULL)),
  CONSTRAINT inventory_issues_cond_out_chk CHECK (condition_out IS NULL OR condition_out IN ('new', 'good', 'fair', 'poor', 'broken')),
  CONSTRAINT inventory_issues_cond_ret_chk CHECK (returned_condition IS NULL OR returned_condition IN ('new', 'good', 'fair', 'poor', 'broken')),
  CONSTRAINT inventory_issues_note_chk CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE INDEX inventory_issues_item_idx ON inventory_issues (item_id, issued_at DESC);
CREATE INDEX inventory_issues_open_idx ON inventory_issues (tenant_id, status, due_on) WHERE status = 'out';

CREATE FUNCTION public.inventory_out_count(p_item uuid) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(sum(quantity), 0)::int FROM public.inventory_issues WHERE item_id = p_item AND status = 'out';
$$;
REVOKE ALL ON FUNCTION public.inventory_out_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_out_count(uuid) TO figbloom_app;

CREATE FUNCTION public.inventory_items_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'An item cannot be moved to another school' USING ERRCODE = '42501';
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.asset_tag := nullif(btrim(coalesce(NEW.asset_tag, '')), '');
  NEW.location := nullif(btrim(coalesce(NEW.location, '')), '');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_items_stamp BEFORE INSERT OR UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.inventory_items_stamp();
REVOKE ALL ON FUNCTION public.inventory_items_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inventory_items_stamp() FROM figbloom_app;

CREATE FUNCTION public.inventory_issues_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_item public.inventory_items%ROWTYPE;
  v_out integer;
BEGIN
  SELECT * INTO v_item FROM public.inventory_items WHERE id = NEW.item_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found' USING ERRCODE = '23503';
  END IF;
  IF v_item.retired_at IS NOT NULL AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Retired items cannot be issued' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'out';
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
    v_out := public.inventory_out_count(NEW.item_id);
    IF v_out + NEW.quantity > v_item.quantity THEN
      RAISE EXCEPTION 'Not enough copies available' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'out' THEN
      RAISE EXCEPTION 'A closed issue is final' USING ERRCODE = '23514';
    END IF;
    IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.learner_id IS DISTINCT FROM OLD.learner_id OR NEW.holder_user_id IS DISTINCT FROM OLD.holder_user_id
       OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'Issue identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'out' AND NEW.closed_at IS NULL THEN
      NEW.closed_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_issues_guard BEFORE INSERT OR UPDATE ON inventory_issues
  FOR EACH ROW EXECUTE FUNCTION public.inventory_issues_guard();
REVOKE ALL ON FUNCTION public.inventory_issues_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inventory_issues_guard() FROM figbloom_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_items', 'inventory_issues'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON inventory_items TO figbloom_app;
GRANT UPDATE (name, category, tracking, quantity, asset_tag, condition, location, purchased_on, unit_cost_cents, notes, retired_at, updated_at) ON inventory_items TO figbloom_app;
GRANT SELECT, INSERT ON inventory_issues TO figbloom_app;
GRANT UPDATE (status, returned_condition, closed_at, closed_by, note, due_on, condition_out) ON inventory_issues TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON inventory_items FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON inventory_issues FROM figbloom_app;
