-- Stock reports (docs/INVENTORY-STOCK.md, slice S1b). A port of the report functions of the live Supabase migration
-- 20261124200000_inventory_movements.sql, with the same maths, kept as close to the Supabase text as the API allows so the two
-- can be read side by side:
--
--   inventory_price_on           what one unit of an item cost on a day
--   inventory_qty_text           "25 kg", "1 bag": a quantity and its unit as the flags write them
--   inventory_ledger             everything that went in or out of a school's stock lines in a period
--   inventory_usage              use, waste, deliveries, shrinkage and spend per item per day / week / month / year
--   inventory_spend_by_month     what deliveries cost, month by month and store by store
--   inventory_cost_per_meal      kitchen food used, priced, over meals served
--   inventory_stock_levels       on hand, value, average daily use, days of cover, low, next delivery
--   inventory_headcount          learners, staff and visitors on each day
--   inventory_consumption_flags  the deterministic anomaly flags
--
-- What differs from Supabase (each explained in docs/INVENTORY-STOCK.md):
--   * SECURITY INVOKER, not definer. Each runs as the caller under row security, and refuses a school other than the one of
--     the request (app_current_tenant_id()). Who may call them is decided by the route (resource.inventory.read), as for
--     every other API read; inventory_may_read() is not ported.
--   * The ledger holds movements only: the API's sick bay does not take medicine from stock, so there is no sick-bay part.
--   * The API's own tables: learners (Supabase students), staff_members (profiles that are not parents or students; there is
--     no left_on, so a staff record counts until it is archived), gate_visits (visits), academic_terms (terms).
--   * "Today" is the school's today (finance_school_today), not the database's current_date.
--   * Headcount inside the flags is not capped at 400 days: on Supabase the flags call inventory_headcount over the period
--     plus 70 days, so a period longer than about 330 days fails there. The flags still refuse more than 366 days.
--   * Money sums are numeric, so a large sum never overflows; the values are the same.
--
-- Forward-only. Adds functions only; no table changes.

CREATE FUNCTION public.inventory_assert_tenant(p_tenant_id uuid) RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.app_current_tenant_id() THEN
    RAISE EXCEPTION 'Only the school''s staff can see its stock reports' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- What one unit of an item cost on a day: the latest priced delivery on or before it, else the register's price.
CREATE FUNCTION public.inventory_price_on(p_item_id uuid, p_day date) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    (SELECT r.unit_cost_cents FROM public.inventory_movements r
      WHERE r.item_id = p_item_id AND r.kind = 'received' AND r.unit_cost_cents IS NOT NULL AND r.occurred_on <= p_day
      ORDER BY r.occurred_on DESC, r.created_at DESC LIMIT 1),
    (SELECT i.unit_cost_cents FROM public.inventory_items i WHERE i.id = p_item_id))
$$;

-- "25 kg", "1 bag", "3 litres": a quantity and its unit as the flags write them.
CREATE FUNCTION public.inventory_qty_text(p_qty numeric, p_unit text) RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT trim_scale(round(p_qty, 2))::text
         || coalesce(' ' || CASE WHEN abs(p_qty) = 1 THEN regexp_replace(p_unit, '([^s])s$', '\1') ELSE p_unit END, '')
$$;

-- Everything that went in or out of a school's stock lines in a period. Movements only (see above). No person comes out of
-- it: an item, an amount and a day.
CREATE FUNCTION public.inventory_ledger(p_tenant_id uuid, p_from date, p_to date)
RETURNS TABLE (item_id uuid, kind text, quantity int, occurred_on date, purpose text, meals_served int,
               unit_cost_cents bigint, supplier text, created_at timestamptz, source text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.inventory_assert_tenant(p_tenant_id);
  RETURN QUERY
  SELECT m.item_id, m.kind, m.quantity, m.occurred_on, m.purpose, m.meals_served, m.unit_cost_cents, m.supplier, m.created_at,
         'movement'::text
    FROM public.inventory_movements m
   WHERE m.tenant_id = p_tenant_id AND m.occurred_on BETWEEN p_from AND p_to;
END;
$$;

-- Use, waste, deliveries, shrinkage (stock-take shortfalls) and money per item per period. p_bucket: 'day', 'week' (ISO,
-- from Monday), 'month' or 'year'.
CREATE FUNCTION public.inventory_usage(p_tenant_id uuid, p_from date, p_to date, p_bucket text DEFAULT 'week')
RETURNS TABLE (item_id uuid, period_start date, used bigint, wasted bigint, received bigint, shrinkage bigint,
               spend_cents numeric, used_cost_cents numeric)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.inventory_assert_tenant(p_tenant_id);
  IF p_bucket IS NULL OR p_bucket NOT IN ('day', 'week', 'month', 'year') THEN
    RAISE EXCEPTION 'p_bucket must be day, week, month or year' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT m.item_id, date_trunc(p_bucket, m.occurred_on::timestamp)::date,
    coalesce(sum(m.quantity) FILTER (WHERE m.kind = 'used'), 0)::bigint,
    coalesce(sum(m.quantity) FILTER (WHERE m.kind = 'wasted'), 0)::bigint,
    coalesce(sum(m.quantity) FILTER (WHERE m.kind = 'received'), 0)::bigint,
    coalesce(-sum(m.quantity) FILTER (WHERE m.kind = 'adjusted' AND m.quantity < 0), 0)::bigint,
    coalesce(sum(m.quantity::numeric * m.unit_cost_cents) FILTER (WHERE m.kind = 'received'), 0),
    coalesce(sum(m.quantity::numeric * public.inventory_price_on(m.item_id, m.occurred_on)) FILTER (WHERE m.kind = 'used'), 0)
  FROM public.inventory_ledger(p_tenant_id, p_from, p_to) m
  GROUP BY 1, 2
  ORDER BY 2, 1;
END;
$$;

-- What deliveries cost, month by month and store by store (inventory_items.category).
CREATE FUNCTION public.inventory_spend_by_month(p_tenant_id uuid, p_from date, p_to date)
RETURNS TABLE (month date, category text, spend_cents numeric, deliveries int)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.inventory_assert_tenant(p_tenant_id);
  RETURN QUERY
  SELECT date_trunc('month', m.occurred_on::timestamp)::date, i.category,
    coalesce(sum(m.quantity::numeric * m.unit_cost_cents), 0),
    count(*)::int
  FROM public.inventory_movements m
  JOIN public.inventory_items i ON i.id = m.item_id AND i.tenant_id = m.tenant_id
  WHERE m.tenant_id = p_tenant_id AND m.kind = 'received' AND m.occurred_on BETWEEN p_from AND p_to
  GROUP BY 1, 2
  ORDER BY 1, 2;
END;
$$;

-- Kitchen food used (priced at the delivery price of the day) over meals served, per period and purpose. Meals are counted
-- once per day and purpose (the largest meals_served recorded on that day's lines for it), since rice and beans for the same
-- lunch both say how many ate.
CREATE FUNCTION public.inventory_cost_per_meal(p_tenant_id uuid, p_from date, p_to date, p_bucket text DEFAULT 'month')
RETURNS TABLE (period_start date, purpose text, used_cost_cents numeric, meals_served bigint, cost_per_meal_cents numeric)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.inventory_assert_tenant(p_tenant_id);
  IF p_bucket IS NULL OR p_bucket NOT IN ('day', 'week', 'month', 'year') THEN
    RAISE EXCEPTION 'p_bucket must be day, week, month or year' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH used AS (
    SELECT m.occurred_on AS day, coalesce(m.purpose, 'Other') AS purpose,
      sum(m.quantity::numeric * coalesce(public.inventory_price_on(m.item_id, m.occurred_on), 0)) AS cost,
      max(m.meals_served) AS meals
    FROM public.inventory_movements m
    JOIN public.inventory_items i ON i.id = m.item_id AND i.tenant_id = m.tenant_id
    WHERE m.tenant_id = p_tenant_id AND m.kind = 'used' AND i.category = 'kitchen'
      AND m.occurred_on BETWEEN p_from AND p_to
    GROUP BY 1, 2
  )
  SELECT date_trunc(p_bucket, u.day::timestamp)::date, u.purpose, sum(u.cost), coalesce(sum(u.meals), 0)::bigint,
    -- only days that recorded meals count towards the cost of a meal
    round(sum(u.cost) FILTER (WHERE u.meals > 0) / nullif(sum(u.meals) FILTER (WHERE u.meals > 0), 0), 2)
  FROM used u
  GROUP BY 1, 2
  ORDER BY 1, 2;
END;
$$;

-- Every live stock line as of a day: what's on hand and what it's worth, the average daily use over the 28 days to then, how
-- many days that lasts, whether it is at or below its reorder level, and when the next delivery usually comes (the last one
-- plus the median gap between deliveries in the 120 days before).
CREATE FUNCTION public.inventory_stock_levels(p_tenant_id uuid, p_as_of date)
RETURNS TABLE (item_id uuid, name text, category text, unit text, consumable boolean, quantity int, reorder_level int,
               unit_cost_cents bigint, value_cents numeric, used_28d bigint, wasted_28d bigint, avg_daily_use numeric,
               days_of_cover numeric, low boolean, last_received_on date, next_delivery_on date)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.inventory_assert_tenant(p_tenant_id);
  RETURN QUERY
  WITH u AS (
    SELECT l.item_id,
      coalesce(sum(l.quantity) FILTER (WHERE l.kind = 'used'), 0)::bigint AS used,
      coalesce(sum(l.quantity) FILTER (WHERE l.kind = 'wasted'), 0)::bigint AS wasted
    FROM public.inventory_ledger(p_tenant_id, p_as_of - 27, p_as_of) l
    GROUP BY 1
  )
  SELECT i.id, i.name, i.category, i.unit, i.consumable, i.quantity, i.reorder_level, i.unit_cost_cents,
    (i.quantity::numeric * coalesce(i.unit_cost_cents, 0)),
    coalesce(u.used, 0), coalesce(u.wasted, 0),
    round(coalesce(u.used, 0) / 28.0, 2),
    CASE WHEN u.used > 0 THEN round(i.quantity / (u.used / 28.0), 1) END,
    i.reorder_level IS NOT NULL AND i.quantity <= i.reorder_level,
    d.last_on,
    (d.last_on + d.gap)::date
  FROM public.inventory_items i
  LEFT JOIN u ON u.item_id = i.id
  CROSS JOIN LATERAL (
    SELECT max(r.day) AS last_on,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.gap))::int AS gap
    FROM (
      SELECT x.day, x.day - lag(x.day) OVER (ORDER BY x.day) AS gap
      FROM (SELECT DISTINCT m.occurred_on AS day FROM public.inventory_movements m
            WHERE m.item_id = i.id AND m.tenant_id = p_tenant_id AND m.kind = 'received'
              AND m.occurred_on > p_as_of - 120 AND m.occurred_on <= p_as_of) x
    ) r
  ) d
  WHERE i.tenant_id = p_tenant_id AND i.tracking = 'stock' AND i.retired_at IS NULL
  ORDER BY i.category, i.name, i.id;
END;
$$;

-- Mouths to feed on each day: learners on the roll then (archived ones until the day they were archived), staff then (until
-- they were archived), and visitors who signed in at the gate that day (the school's own time zone). Counts only.
CREATE FUNCTION public.inventory_headcount(p_tenant_id uuid, p_from date, p_to date)
RETURNS TABLE (day date, learners int, staff int, visitors int)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.inventory_assert_tenant(p_tenant_id);
  IF p_to - p_from > 400 THEN
    RAISE EXCEPTION 'Ask for at most 400 days at a time' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT * FROM public.inventory_headcount_days(p_tenant_id, p_from, p_to);
END;
$$;

-- The days of inventory_headcount without its 400-day limit, for the flags (see above). Not callable by the application.
CREATE FUNCTION public.inventory_headcount_days(p_tenant_id uuid, p_from date, p_to date)
RETURNS TABLE (day date, learners int, staff int, visitors int)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tz text;
BEGIN
  PERFORM public.inventory_assert_tenant(p_tenant_id);
  SELECT coalesce(t.timezone, 'Africa/Nairobi') INTO v_tz FROM public.tenants t WHERE t.id = p_tenant_id;
  RETURN QUERY
  WITH days AS (SELECT g::date AS day FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g),
  v AS (
    SELECT (vi.arrived_at AT TIME ZONE v_tz)::date AS day, count(*)::int AS n
    FROM public.gate_visits vi
    WHERE vi.tenant_id = p_tenant_id
      AND vi.arrived_at >= (p_from::timestamp AT TIME ZONE v_tz) AND vi.arrived_at < ((p_to + 1)::timestamp AT TIME ZONE v_tz)
    GROUP BY 1
  ),
  -- the school's learners and staff read once, then counted for each day
  st AS MATERIALIZED (
    SELECT s.archived_at IS NULL AS current, (s.archived_at AT TIME ZONE v_tz)::date AS archived_on
    FROM public.learners s
    WHERE s.tenant_id = p_tenant_id AND ((s.archived_at IS NULL AND s.active) OR s.archived_at IS NOT NULL)
  ),
  pr AS MATERIALIZED (
    SELECT (p.archived_at AT TIME ZONE v_tz)::date AS archived_on
    FROM public.staff_members p
    WHERE p.tenant_id = p_tenant_id
  )
  SELECT d.day,
    (SELECT count(*)::int FROM st WHERE st.current OR st.archived_on > d.day),
    (SELECT count(*)::int FROM pr WHERE pr.archived_on IS NULL OR pr.archived_on > d.day),
    coalesce(v.n, 0)
  FROM days d LEFT JOIN v ON v.day = d.day
  ORDER BY d.day;
END;
$$;

-- The anomaly flags, worked out in SQL so they hold with AI switched off. Same sections, thresholds and wording as
-- Supabase's inventory_consumption_flags (read its comment in 20261124200000 for what each kind means):
-- usage_up / usage_down (kitchen per day per head; other stores per complete week per driver), usage_trend (kitchen, last
-- 7 days against 3 weeks before), non_school_day, shrinkage, price_jump, run_out (worked out for the school's today).
CREATE FUNCTION public.inventory_consumption_flags(p_tenant_id uuid, p_from date, p_to date)
RETURNS TABLE (kind text, item_id uuid, item_name text, category text, unit text, purpose text, occurred_on date, period_from date,
               expected numeric, actual numeric, headcount int, baseline_headcount int, visitors int,
               severity text, explained boolean, reason text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_boarders boolean;
  v_tz text;
  v_today date;
BEGIN
  PERFORM public.inventory_assert_tenant(p_tenant_id);
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Ask for at most a year, from before to' USING ERRCODE = '22023';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.learners s WHERE s.tenant_id = p_tenant_id AND s.active AND s.boarding) INTO v_boarders;
  SELECT coalesce(t.timezone, 'Africa/Nairobi') INTO v_tz FROM public.tenants t WHERE t.id = p_tenant_id;
  v_today := public.finance_school_today(p_tenant_id);

  -- ------------------------------------------------ kitchen: daily use against its baseline
  RETURN QUERY
  WITH hc AS (SELECT * FROM public.inventory_headcount_days(p_tenant_id, p_from - 70, p_to)),
  daily AS (
    SELECT m.item_id, coalesce(m.purpose, '') AS purpose, m.occurred_on AS day,
      sum(m.quantity)::numeric AS qty, max(m.meals_served) AS meals
    FROM public.inventory_ledger(p_tenant_id, p_from - 70, p_to) m JOIN public.inventory_items i ON i.id = m.item_id
    WHERE m.kind = 'used' AND i.consumable AND i.category = 'kitchen'
    GROUP BY 1, 2, 3
  ),
  d2 AS (
    SELECT d.*, coalesce(d.meals, h.learners + h.staff + h.visitors)::numeric AS heads, (d.meals IS NOT NULL) AS by_meals,
      h.visitors, extract(isodow FROM d.day) >= 6 AS weekend
    FROM daily d JOIN hc h ON h.day = d.day
  ),
  cmp AS (
    SELECT d.*, b.n, b.med_qty, b.med_heads, b.med_ph
    FROM d2 d
    CROSS JOIN LATERAL (
      SELECT count(*) AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.qty) AS med_qty,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.heads) AS med_heads,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.qty / p.heads) AS med_ph
      FROM (SELECT * FROM d2 p
            WHERE p.item_id = d.item_id AND p.purpose = d.purpose AND p.day < d.day AND p.weekend = d.weekend
              AND p.by_meals = d.by_meals AND p.heads > 0
            ORDER BY p.day DESC LIMIT 4) p
    ) b
    WHERE d.day BETWEEN p_from AND p_to AND b.n >= 3 AND d.heads > 0 AND b.med_ph > 0
  ),
  scored AS (
    SELECT c.*, (c.qty / c.heads) / c.med_ph::numeric - 1 AS ph_change, c.qty / c.med_qty::numeric - 1 AS qty_change,
      c.heads / c.med_heads::numeric - 1 AS head_change
    FROM cmp c
  )
  -- an explained rise is a rise in use, whichever way use per head moved within the threshold
  SELECT CASE WHEN abs(s.ph_change) <= 0.15 OR s.ph_change > 0 THEN 'usage_up' ELSE 'usage_down' END,
    s.item_id, i.name, i.category, i.unit, nullif(s.purpose, ''), s.day, NULL::date,
    round(s.med_ph::numeric * s.heads, 1), s.qty, s.heads::int, round(s.med_heads::numeric)::int, s.visitors,
    CASE WHEN abs(s.ph_change) <= 0.15 THEN 'low' WHEN s.ph_change > 0.20 THEN 'high' WHEN s.ph_change > 0 THEN 'medium' ELSE 'low' END,
    abs(s.ph_change) <= 0.15,
    CASE WHEN abs(s.ph_change) <= 0.15 THEN
      format('%s of %s used on %s against about %s usually, but %s rose too (%s to %s%s): use per head is normal.',
        public.inventory_qty_text(s.qty, i.unit), i.name || coalesce(' for ' || nullif(s.purpose, ''), ''), to_char(s.day, 'Dy DD Mon'),
        trim_scale(round(s.med_qty::numeric, 1)), CASE WHEN s.by_meals THEN 'meals served' ELSE 'headcount' END,
        to_char(s.med_heads, 'FM999,999,990'), to_char(s.heads, 'FM999,999,990'),
        CASE WHEN s.visitors > 0 AND NOT s.by_meals THEN format(', %s visitors', s.visitors) ELSE '' END)
    ELSE
      format('%s of %s used on %s against about %s expected; %s %s (%s to %s). Use per head %s %s%%.',
        public.inventory_qty_text(s.qty, i.unit), i.name || coalesce(' for ' || nullif(s.purpose, ''), ''), to_char(s.day, 'Dy DD Mon'),
        trim_scale(round(s.med_ph::numeric * s.heads, 1)),
        CASE WHEN s.by_meals THEN 'meals served' ELSE 'learners, staff and visitors' END,
        CASE WHEN abs(s.head_change) < 0.05 THEN 'about the same' WHEN s.head_change > 0 THEN 'up' ELSE 'down' END,
        to_char(s.med_heads, 'FM999,999,990'), to_char(s.heads, 'FM999,999,990'),
        CASE WHEN s.ph_change > 0 THEN 'up' ELSE 'down' END, round(abs(s.ph_change) * 100))
    END
  FROM scored s JOIN public.inventory_items i ON i.id = s.item_id
  -- and at least one whole unit off what was expected: a bag of potatoes against 1.2 is not news
  WHERE (abs(s.ph_change) > 0.15 AND abs(s.qty - s.med_ph::numeric * s.heads) >= 1)
     OR (abs(s.ph_change) <= 0.15 AND s.qty_change > 0.15 AND s.head_change > 0.10);

  -- ------------------------------------------------ every other store: weekly use against its baseline
  RETURN QUERY
  WITH hc AS (
    SELECT date_trunc('week', h.day::timestamp)::date AS wk,
      avg(h.learners + h.staff + h.visitors) FILTER (WHERE extract(isodow FROM h.day) < 6) AS heads,
      sum(h.visitors)::int AS visitors
    FROM public.inventory_headcount_days(p_tenant_id, (date_trunc('week', p_from::timestamp)::date - 70), p_to) h
    GROUP BY 1
  ),
  sbv AS (
    SELECT date_trunc('week', (v.time_in AT TIME ZONE v_tz)::date::timestamp)::date AS wk, count(*)::numeric AS n
    FROM public.sick_bay_visits v
    WHERE v.tenant_id = p_tenant_id AND v.time_in >= ((date_trunc('week', p_from::timestamp)::date - 70)::timestamp AT TIME ZONE v_tz)
    GROUP BY 1
  ),
  weekly AS (
    SELECT m.item_id, i.category, coalesce(m.purpose, '') AS purpose, date_trunc('week', m.occurred_on::timestamp)::date AS wk,
      sum(m.quantity)::numeric AS qty, count(DISTINCT m.occurred_on)::numeric AS use_days
    FROM public.inventory_ledger(p_tenant_id, date_trunc('week', p_from::timestamp)::date - 70, p_to) m
    JOIN public.inventory_items i ON i.id = m.item_id
    WHERE m.kind = 'used' AND i.consumable AND i.category <> 'kitchen'
    GROUP BY 1, 2, 3, 4
  ),
  w2 AS (
    SELECT w.*,
      CASE WHEN w.category = 'lab_equipment' THEN w.use_days
           WHEN w.category = 'medical' THEN coalesce(sv.n, w.use_days)
           ELSE h.heads END::numeric AS driver,
      CASE WHEN w.category = 'lab_equipment' THEN 'practicals' WHEN w.category = 'medical' AND sv.n IS NOT NULL THEN 'sick-bay visits'
           WHEN w.category = 'medical' THEN 'days used' ELSE 'learners, staff and visitors' END AS driver_label,
      CASE WHEN w.category IN ('lab_equipment', 'medical') THEN NULL ELSE h.visitors END AS visitors
    FROM weekly w LEFT JOIN hc h ON h.wk = w.wk LEFT JOIN sbv sv ON sv.wk = w.wk
  ),
  cmp AS (
    SELECT w.*, b.n, b.med_qty, b.med_driver, b.med_pu
    FROM w2 w
    CROSS JOIN LATERAL (
      SELECT count(*) AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.qty) AS med_qty,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.driver) AS med_driver,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY p.qty / p.driver) AS med_pu
      FROM (SELECT * FROM w2 p
            WHERE p.item_id = w.item_id AND p.purpose = w.purpose AND p.wk < w.wk AND p.driver > 0
            ORDER BY p.wk DESC LIMIT 4) p
    ) b
    -- complete weeks that end in the period
    WHERE w.wk + 6 BETWEEN p_from AND p_to AND b.n >= 3 AND w.driver > 0 AND b.med_pu > 0
  ),
  scored AS (
    SELECT c.*, (c.qty / c.driver) / c.med_pu::numeric - 1 AS pu_change, c.qty / c.med_qty::numeric - 1 AS qty_change,
      c.driver / c.med_driver::numeric - 1 AS driver_change
    FROM cmp c
  )
  SELECT CASE WHEN abs(s.pu_change) <= 0.25 OR s.pu_change > 0 THEN 'usage_up' ELSE 'usage_down' END,
    s.item_id, i.name, i.category, i.unit, nullif(s.purpose, ''), s.wk + 6, s.wk,
    round(s.med_pu::numeric * s.driver, 1), s.qty, round(s.driver)::int, round(s.med_driver::numeric)::int, s.visitors,
    CASE WHEN abs(s.pu_change) <= 0.25 THEN 'low' WHEN s.pu_change > 0.50 THEN 'high' WHEN s.pu_change > 0 THEN 'medium' ELSE 'low' END,
    abs(s.pu_change) <= 0.25,
    CASE WHEN abs(s.pu_change) <= 0.25 THEN
      format('Week of %s: %s of %s used against about %s usually, but %s rose too (%s to %s): use per %s is normal.',
        to_char(s.wk, 'DD Mon'), public.inventory_qty_text(s.qty, i.unit), i.name || coalesce(' for ' || nullif(s.purpose, ''), ''),
        trim_scale(round(s.med_qty::numeric, 1)), s.driver_label,
        to_char(s.med_driver, 'FM999,999,990'), to_char(s.driver, 'FM999,999,990'),
        CASE s.driver_label WHEN 'practicals' THEN 'practical' WHEN 'sick-bay visits' THEN 'visit' WHEN 'days used' THEN 'day' ELSE 'head' END)
    ELSE
      format('Week of %s: %s of %s used against about %s expected; %s %s (%s to %s). Use per %s %s %s%%.',
        to_char(s.wk, 'DD Mon'), public.inventory_qty_text(s.qty, i.unit), i.name || coalesce(' for ' || nullif(s.purpose, ''), ''),
        trim_scale(round(s.med_pu::numeric * s.driver, 1)), s.driver_label,
        CASE WHEN abs(s.driver_change) < 0.05 THEN 'about the same' WHEN s.driver_change > 0 THEN 'up' ELSE 'down' END,
        to_char(s.med_driver, 'FM999,999,990'), to_char(s.driver, 'FM999,999,990'),
        CASE s.driver_label WHEN 'practicals' THEN 'practical' WHEN 'sick-bay visits' THEN 'visit' WHEN 'days used' THEN 'day' ELSE 'head' END,
        CASE WHEN s.pu_change > 0 THEN 'up' ELSE 'down' END, round(abs(s.pu_change) * 100))
    END
  FROM scored s JOIN public.inventory_items i ON i.id = s.item_id
  WHERE (abs(s.pu_change) > 0.25 AND abs(s.qty - s.med_pu::numeric * s.driver) >= 1)
     OR (abs(s.pu_change) <= 0.25 AND s.qty_change > 0.25 AND s.driver_change > 0.10);

  -- ------------------------------------------------ kitchen: slow creep, last 7 days against 3 weeks before
  RETURN QUERY
  WITH hc AS (SELECT * FROM public.inventory_headcount_days(p_tenant_id, p_to - 27, p_to)),
  daily AS (
    SELECT m.item_id, m.occurred_on AS day, sum(m.quantity)::numeric AS qty
    FROM public.inventory_ledger(p_tenant_id, p_to - 27, p_to) m JOIN public.inventory_items i ON i.id = m.item_id
    WHERE m.kind = 'used' AND i.consumable AND i.category = 'kitchen'
    GROUP BY 1, 2
  ),
  w AS (
    SELECT d.item_id, d.day > p_to - 7 AS recent,
      sum(d.qty) AS qty, sum(h.learners + h.staff + h.visitors)::numeric AS heads, count(*) AS days
    FROM daily d JOIN hc h ON h.day = d.day
    WHERE d.day > p_to - 7 OR d.day <= p_to - 21
    GROUP BY 1, 2
  ),
  t AS (
    SELECT r.item_id, r.qty / r.days AS qty_now, e.qty / e.days AS qty_then, r.heads / r.days AS heads_now, e.heads / e.days AS heads_then,
      (r.qty / r.heads) / (e.qty / e.heads) - 1 AS ph_change, (r.heads / r.days) / (e.heads / e.days) - 1 AS head_change
    FROM w r JOIN w e ON e.item_id = r.item_id AND NOT e.recent
    WHERE r.recent AND r.days >= 3 AND e.days >= 3 AND r.heads > 0 AND e.heads > 0 AND e.qty > 0
  )
  SELECT 'usage_trend', t.item_id, i.name, i.category, i.unit, NULL::text, p_to, p_to - 27,
    round(t.qty_then * (t.heads_now / t.heads_then), 1), round(t.qty_now, 1), round(t.heads_now)::int, round(t.heads_then)::int, NULL::int,
    CASE WHEN t.ph_change <= 0.15 THEN 'low' WHEN t.ph_change > 0.30 THEN 'high' ELSE 'medium' END,
    t.ph_change <= 0.15,
    format('%s use has crept up: about %s a day this week against %s three weeks ago, with headcount %s (%s to %s). Use per head up %s%%.',
      i.name, public.inventory_qty_text(round(t.qty_now, 1), i.unit), trim_scale(round(t.qty_then, 1)),
      CASE WHEN abs(t.head_change) < 0.05 THEN 'about the same' WHEN t.head_change > 0 THEN 'up' ELSE 'down' END,
      to_char(round(t.heads_then), 'FM999,999,990'), to_char(round(t.heads_now), 'FM999,999,990'), round(t.ph_change * 100))
  FROM t JOIN public.inventory_items i ON i.id = t.item_id
  WHERE t.ph_change > 0.15 OR (t.qty_now / t.qty_then - 1 > 0.15 AND t.head_change > 0.10);

  -- ------------------------------------------------ use on a day the school is shut
  RETURN QUERY
  SELECT 'non_school_day', m.item_id, i.name, i.category, i.unit, max(m.purpose), m.occurred_on, NULL::date,
    0::numeric, sum(m.quantity)::numeric, NULL::int, NULL::int, NULL::int,
    'medium', false,
    format('%s of %s recorded as %s on %s, %s.', public.inventory_qty_text(sum(m.quantity), i.unit), i.name,
      string_agg(DISTINCT m.kind, ' and '), to_char(m.occurred_on, 'Dy DD Mon'),
      CASE WHEN NOT EXISTS (SELECT 1 FROM public.academic_terms t WHERE t.tenant_id = p_tenant_id AND m.occurred_on BETWEEN t.starts_on AND t.ends_on)
        THEN 'which is outside every term' ELSE 'a weekend, and the school has no boarders' END)
  FROM public.inventory_ledger(p_tenant_id, p_from, p_to) m JOIN public.inventory_items i ON i.id = m.item_id
  WHERE m.kind IN ('used', 'wasted')
    AND (NOT EXISTS (SELECT 1 FROM public.academic_terms t WHERE t.tenant_id = p_tenant_id AND m.occurred_on BETWEEN t.starts_on AND t.ends_on)
         OR (extract(isodow FROM m.occurred_on) >= 6 AND NOT v_boarders))
  GROUP BY m.item_id, i.name, i.category, i.unit, m.occurred_on;

  -- ------------------------------------------------ stock-take shortfalls beyond normal waste
  RETURN QUERY
  WITH l AS (SELECT * FROM public.inventory_ledger(p_tenant_id, p_from - 30, p_to)),
  a AS (
    SELECT m.*,
      (SELECT coalesce(sum(x.quantity), 0) FROM public.inventory_movements x
        WHERE x.item_id = m.item_id AND x.kind = 'wasted' AND x.occurred_on BETWEEN m.occurred_on - 30 AND m.occurred_on) AS waste30,
      (SELECT coalesce(sum(x.quantity), 0) FROM l x
        WHERE x.item_id = m.item_id AND x.kind = 'used' AND x.occurred_on BETWEEN m.occurred_on - 30 AND m.occurred_on) AS use30
    FROM public.inventory_movements m JOIN public.inventory_items i ON i.id = m.item_id
    WHERE m.tenant_id = p_tenant_id AND m.kind = 'adjusted' AND m.quantity < 0 AND i.consumable
      AND m.occurred_on BETWEEN p_from AND p_to
  ),
  b AS (SELECT a.*, greatest(a.waste30, ceil(a.use30 * 0.02)) AS allowance FROM a)
  SELECT 'shrinkage', b.item_id, i.name, i.category, i.unit, NULL::text, b.occurred_on, b.occurred_on - 30,
    b.allowance::numeric, (-b.quantity)::numeric, NULL::int, NULL::int, NULL::int,
    CASE WHEN -b.quantity > 2 * b.allowance THEN 'high' ELSE 'medium' END, false,
    format('Stock-take on %s found %s of %s short; normal waste over the month before was about %s.',
      to_char(b.occurred_on, 'Dy DD Mon'), public.inventory_qty_text(-b.quantity, i.unit), i.name, public.inventory_qty_text(b.allowance, i.unit))
  FROM b JOIN public.inventory_items i ON i.id = b.item_id
  WHERE -b.quantity > b.allowance;

  -- ------------------------------------------------ a delivery priced well above the usual
  RETURN QUERY
  WITH r AS (
    SELECT m.*,
      (SELECT count(*) FROM (SELECT 1 FROM public.inventory_movements x WHERE x.item_id = m.item_id AND x.kind = 'received'
          AND x.unit_cost_cents IS NOT NULL AND lower(x.supplier) = lower(m.supplier)
          AND (x.occurred_on, x.created_at) < (m.occurred_on, m.created_at) LIMIT 4) q) AS same_n
    FROM public.inventory_movements m
    WHERE m.tenant_id = p_tenant_id AND m.kind = 'received' AND m.unit_cost_cents IS NOT NULL AND m.occurred_on BETWEEN p_from AND p_to
  ),
  b AS (
    SELECT r.*, (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY p.unit_cost_cents)
      FROM (SELECT x.unit_cost_cents FROM public.inventory_movements x
            WHERE x.item_id = r.item_id AND x.kind = 'received' AND x.unit_cost_cents IS NOT NULL
              AND (x.occurred_on, x.created_at) < (r.occurred_on, r.created_at)
              AND (r.same_n < 2 OR lower(x.supplier) = lower(r.supplier))
            ORDER BY x.occurred_on DESC, x.created_at DESC LIMIT 4) p
    ) AS usual
    FROM r
  )
  SELECT 'price_jump', b.item_id, i.name, i.category, i.unit, NULL::text, b.occurred_on, NULL::date,
    round(b.usual::numeric), b.unit_cost_cents::numeric, NULL::int, NULL::int, NULL::int,
    CASE WHEN b.unit_cost_cents > b.usual * 1.4 THEN 'high' ELSE 'medium' END, false,
    format('%s delivered on %s%s at %s a %s, %s%% above the usual %s.',
      i.name, to_char(b.occurred_on, 'Dy DD Mon'), coalesce(' by ' || b.supplier, ''),
      trim_scale(round(b.unit_cost_cents / 100.0, 2)), coalesce(regexp_replace(i.unit, '([^s])s$', '\1'), 'unit'),
      round((b.unit_cost_cents / b.usual::numeric - 1) * 100), trim_scale(round(b.usual::numeric / 100, 2)))
  FROM b JOIN public.inventory_items i ON i.id = b.item_id
  WHERE b.usual > 0 AND b.unit_cost_cents > b.usual * 1.2;

  -- ------------------------------------------------ running out before the next delivery (worked out for the school's today)
  RETURN QUERY
  SELECT 'run_out', l.item_id, l.name, l.category, l.unit, NULL::text, v_today, NULL::date,
    (l.next_delivery_on - v_today)::numeric, l.days_of_cover, NULL::int, NULL::int, NULL::int,
    CASE WHEN coalesce(l.days_of_cover, 0) < 3 THEN 'high' ELSE 'medium' END, false,
    CASE WHEN l.next_delivery_on IS NOT NULL AND l.days_of_cover IS NOT NULL
           AND v_today + floor(l.days_of_cover)::int < l.next_delivery_on THEN
      format('%s of %s left lasts about %s days at %s a day; the next delivery usually comes on %s. Reorder now.',
        public.inventory_qty_text(l.quantity, l.unit), l.name, trim_scale(l.days_of_cover), public.inventory_qty_text(round(l.avg_daily_use, 1), l.unit),
        to_char(l.next_delivery_on, 'Dy DD Mon'))
    ELSE
      format('%s is at %s, at or below its reorder level of %s.', l.name, public.inventory_qty_text(l.quantity, l.unit), public.inventory_qty_text(l.reorder_level, l.unit))
    END
  FROM public.inventory_stock_levels(p_tenant_id, v_today) l
  WHERE l.consumable AND (
    (l.next_delivery_on IS NOT NULL AND l.days_of_cover IS NOT NULL AND v_today + floor(l.days_of_cover)::int < l.next_delivery_on)
    OR ((l.next_delivery_on IS NULL OR l.days_of_cover IS NULL) AND l.low));
END;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.inventory_assert_tenant(uuid)',
    'public.inventory_price_on(uuid, date)',
    'public.inventory_qty_text(numeric, text)',
    'public.inventory_ledger(uuid, date, date)',
    'public.inventory_usage(uuid, date, date, text)',
    'public.inventory_spend_by_month(uuid, date, date)',
    'public.inventory_cost_per_meal(uuid, date, date, text)',
    'public.inventory_stock_levels(uuid, date)',
    'public.inventory_headcount(uuid, date, date)',
    'public.inventory_headcount_days(uuid, date, date)',
    'public.inventory_consumption_flags(uuid, date, date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO figbloom_app', f);
  END LOOP;
END $$;
