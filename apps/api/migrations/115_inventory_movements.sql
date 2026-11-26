-- Stock in and stock out for consumables (docs/INVENTORY-STOCK.md). A port of the live Supabase migration
-- 20261124200000_inventory_movements.sql (and the same-school and audit guards of 20261125000000), with the same rules:
--
--   inventory_items      gains unit (kg, litres, bags...), consumable (used up rather than handed out and returned), and
--                        reorder_level (warn when stock falls to this).
--   inventory_movements  one delivery, one day's use, waste, or a stock-take correction. Never changed or deleted: they are
--                        the item's history, and a mistake is put right with an 'adjusted' movement. A trigger keeps
--                        inventory_items.quantity in step under a row lock on the item (as inventory_issues_guard does), so
--                        two people using the last 5 kg at once cannot both succeed, and refuses to take stock below zero or
--                        below what the register still owes to issues.
--
-- Differences from Supabase (each explained in docs/INVENTORY-STOCK.md):
--   * "What is out on issues" is inventory_out_count(): issues that are out, lost or damaged (migration 063). On the API a
--     lost or damaged issue stays against the item's count (the count is never reduced), so the stock may not fall below
--     those either; on Supabase lost copies come off the count instead. Same rule, the API's own accounting.
--   * The trigger is SECURITY INVOKER (Supabase: definer). It runs as the caller under row security, so it can only lock
--     and move an item of the school in the request; the runtime role already holds the column grants it needs.
--   * recorded_by is the request's user (app.user_id), never a value from the client.
--   * Same-school references: a composite foreign key (item_id, tenant_id), as inventory_issues has, instead of a trigger.
--   * Audit: the API writes inventory.movement.recorded from the route, as the rest of inventory does.
--
-- Standing rule for tenant tables (TENANT-ISOLATION.md): tenant_id, ENABLE + FORCE row security, one FOR ALL policy for
-- figbloom_app on app_current_tenant_id(), the owner-only policy, minimal grants. figbloom_app may SELECT and INSERT
-- movements; no UPDATE, no DELETE. Forward-only; changes nothing that exists apart from three new item columns.

-- ================================================================ items

ALTER TABLE inventory_items
  ADD COLUMN unit text,
  ADD COLUMN consumable boolean NOT NULL DEFAULT false,
  ADD COLUMN reorder_level integer;
ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_unit_chk CHECK (unit IS NULL OR char_length(unit) BETWEEN 1 AND 20),
  ADD CONSTRAINT inventory_items_reorder_level_chk CHECK (reorder_level IS NULL OR reorder_level >= 0);

-- ================================================================ movements

CREATE TABLE inventory_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  item_id          uuid NOT NULL,
  kind             text NOT NULL,
  -- received: positive; used / wasted: positive amounts taken out; adjusted: signed (stock-take correction)
  quantity         integer NOT NULL,
  unit_cost_cents  bigint,     -- received only
  supplier         text,       -- received only
  reference        text,       -- delivery note / LPO number
  -- the day it happened; the API fills in the school's today (schoolToday) when the client leaves it out, so no default
  -- here: the database's CURRENT_DATE is not a school date
  occurred_on      date NOT NULL,
  -- what it was used for: "Lunch", "Breakfast", "Staff tea", "Science practical"...
  purpose          text,
  -- meals served that day for that purpose (cost per meal); used only
  meals_served     integer,
  note             text,
  -- who recorded it: the request's user. A person who recorded stock cannot be deleted (the history keeps its author).
  recorded_by      uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movements_item_fk FOREIGN KEY (item_id, tenant_id) REFERENCES inventory_items (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT inventory_movements_kind_chk CHECK (kind IN ('received', 'used', 'wasted', 'adjusted')),
  CONSTRAINT inventory_movements_quantity_chk CHECK (quantity <> 0),
  -- the sign rules, exactly
  CONSTRAINT inventory_movements_sign CHECK (kind = 'adjusted' OR quantity > 0),
  CONSTRAINT inventory_movements_received_only CHECK (kind = 'received' OR (unit_cost_cents IS NULL AND supplier IS NULL)),
  CONSTRAINT inventory_movements_used_only CHECK (kind = 'used' OR meals_served IS NULL),
  CONSTRAINT inventory_movements_cost_chk CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  CONSTRAINT inventory_movements_supplier_chk CHECK (supplier IS NULL OR char_length(supplier) <= 160),
  CONSTRAINT inventory_movements_reference_chk CHECK (reference IS NULL OR char_length(reference) <= 80),
  CONSTRAINT inventory_movements_purpose_chk CHECK (purpose IS NULL OR char_length(purpose) <= 120),
  CONSTRAINT inventory_movements_meals_chk CHECK (meals_served IS NULL OR meals_served >= 0),
  CONSTRAINT inventory_movements_note_chk CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE INDEX inventory_movements_item_day_idx ON inventory_movements (tenant_id, item_id, occurred_on);
CREATE INDEX inventory_movements_day_idx ON inventory_movements (tenant_id, occurred_on);
-- The price of an item on a day (the latest priced delivery on or before it), for the stock reports.
CREATE INDEX inventory_movements_received_price_idx ON inventory_movements (item_id, occurred_on DESC, created_at DESC)
  WHERE kind = 'received' AND unit_cost_cents IS NOT NULL;

-- Checks the item, fills in who and when, and moves the stock count, all under a lock on the item so two people using
-- the last 5 kg at once cannot both succeed. Refuses any UPDATE, whoever asks: a movement is the item's history.
CREATE FUNCTION public.inventory_movements_apply() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_item  public.inventory_items%ROWTYPE;
  v_delta integer;
  v_out   integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Stock movements are the item''s history and cannot be changed. Record an adjustment instead.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_item FROM public.inventory_items
   WHERE id = NEW.item_id AND tenant_id = NEW.tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That item is not in this school''s register' USING ERRCODE = '42501';
  END IF;
  IF v_item.tracking <> 'stock' THEN
    RAISE EXCEPTION '% is a single tracked item; only stock lines take deliveries and use', v_item.name USING ERRCODE = '22023';
  END IF;
  IF v_item.retired_at IS NOT NULL THEN
    RAISE EXCEPTION '% has been written off', v_item.name USING ERRCODE = '23514';
  END IF;

  v_delta := CASE NEW.kind WHEN 'received' THEN NEW.quantity WHEN 'adjusted' THEN NEW.quantity ELSE -NEW.quantity END;
  IF v_item.quantity + v_delta < 0 THEN
    RAISE EXCEPTION 'Only % % of % in stock', v_item.quantity, coalesce(v_item.unit, 'left'), v_item.name USING ERRCODE = '23514';
  END IF;
  IF v_delta < 0 THEN
    v_out := public.inventory_out_count(NEW.item_id);
    IF v_item.quantity + v_delta < v_out THEN
      RAISE EXCEPTION '% of % are out with people or not returned; the stock cannot fall below that', v_out, v_item.name
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.supplier    := nullif(btrim(coalesce(NEW.supplier, '')), '');
  NEW.reference   := nullif(btrim(coalesce(NEW.reference, '')), '');
  NEW.purpose     := nullif(btrim(coalesce(NEW.purpose, '')), '');
  NEW.note        := nullif(btrim(coalesce(NEW.note, '')), '');
  NEW.recorded_by := coalesce(public.app_current_user_id(), NEW.recorded_by);
  NEW.created_at  := now();

  UPDATE public.inventory_items
     SET quantity = quantity + v_delta,
         -- the latest price is the item's price
         unit_cost_cents = CASE WHEN NEW.kind = 'received' AND NEW.unit_cost_cents IS NOT NULL
                                THEN NEW.unit_cost_cents ELSE unit_cost_cents END
   WHERE id = NEW.item_id AND tenant_id = NEW.tenant_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_movements_apply() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inventory_movements_apply() FROM figbloom_app;

CREATE TRIGGER inventory_movements_apply BEFORE INSERT OR UPDATE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.inventory_movements_apply();

ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_movements_tenant ON inventory_movements
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY inventory_movements_owner ON inventory_movements
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'inventory_movements'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'inventory_movements'
  ));

-- A movement is never rewritten or removed: SELECT and INSERT only.
GRANT SELECT, INSERT ON inventory_movements TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON inventory_movements FROM figbloom_app;
