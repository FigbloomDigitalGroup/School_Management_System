-- Stock in and stock out for consumables: the kitchen first (rice, beans,
-- maize flour, oil...), and anything else that is used up rather than handed
-- out and returned (chalk, printer paper).
--
--   inventory_items      gains unit (kg, litres, bags...), consumable, and
--                        reorder_level (warn when stock falls to this).
--   inventory_movements  one delivery, one day's use, waste, or a stock-take
--                        correction. Never changed or deleted: they are the
--                        item's history, and a mistake is put right with an
--                        'adjusted' movement. A trigger keeps
--                        inventory_items.quantity in step, under a row lock on
--                        the item (as inventory_issues does), and refuses to
--                        take stock below zero or below what is out on loan.
--
-- Who: the office and holders of the inventory area write (has_perm, as every
-- inventory policy since 20261031000001); staff read; families see nothing.
--
-- Reports (security definer, each checks the caller may read the school's
-- inventory, so the visitor log they count is never exposed row by row):
--   inventory_ledger           every movement plus sick-bay medicine given (visit_medications) as 'used'
--   inventory_usage            use, waste, deliveries and spend per item per day/week/month/year
--   inventory_spend_by_month   what deliveries cost, month by month and store by store
--   inventory_cost_per_meal    kitchen food used, priced, over meals served
--   inventory_stock_levels     on hand, value, average daily use, days of cover, low, next delivery
--   inventory_headcount        learners, staff and visitors on each day
--   inventory_consumption_flags  the deterministic anomaly flags (see its comment)
--
-- And ai_usage accepts the "stock_insights" task (ai-assist), at the end.
--
-- Depends on nothing from the attendance migrations of 2026-11-10.

-- ================================================================ items

-- the unit a stock line is counted in (kg, litres, pieces, bags, crates, packets, reams...)
alter table inventory_items add column unit text check (unit is null or char_length(unit) between 1 and 20);
-- consumable: used up rather than handed out and returned (kitchen food, chalk, printer paper)
alter table inventory_items add column consumable boolean not null default false;
-- warn when stock falls to this
alter table inventory_items add column reorder_level int check (reorder_level is null or reorder_level >= 0);

-- ================================================================ movements

create table inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants on delete cascade,
  item_id         uuid not null references inventory_items on delete cascade,
  kind            text not null check (kind in ('received', 'used', 'wasted', 'adjusted')),
  -- received: positive; used/wasted: positive amounts taken out; adjusted: signed (stock-take correction)
  quantity        int not null check (quantity <> 0),
  unit_cost_cents bigint check (unit_cost_cents is null or unit_cost_cents >= 0),   -- received only
  supplier        text check (supplier is null or char_length(supplier) <= 160),     -- received only
  reference       text check (reference is null or char_length(reference) <= 80),   -- delivery note / LPO no.
  occurred_on     date not null default current_date,
  -- what it was used for: "Lunch", "Breakfast", "Supper", "Staff tea", "Science practical"...
  purpose         text check (purpose is null or char_length(purpose) <= 120),
  -- meals served that day for that purpose (lets the report show cost per meal); used only
  meals_served    int check (meals_served is null or meals_served >= 0),
  note            text check (note is null or char_length(note) <= 1000),
  recorded_by     uuid references profiles on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  -- the sign rules, exactly
  constraint inventory_movements_sign check (kind = 'adjusted' or quantity > 0),
  constraint inventory_movements_received_only check (kind = 'received' or (unit_cost_cents is null and supplier is null)),
  constraint inventory_movements_used_only check (kind = 'used' or meals_served is null)
);
create index on inventory_movements (tenant_id, item_id, occurred_on);
create index on inventory_movements (tenant_id, occurred_on);

alter table inventory_movements enable row level security;

-- Checks the item, fills in who and when, and moves the stock count, all
-- under a lock on the item so two people using the last 5 kg at once can't
-- both succeed.
create or replace function inventory_movements_apply() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_item  inventory_items%rowtype;
  v_delta int;
  v_out   int;
begin
  if TG_OP <> 'INSERT' then
    raise exception 'Stock movements are the item''s history and cannot be changed. Record an adjustment instead.' using errcode = '42501';
  end if;

  select * into v_item from inventory_items where id = NEW.item_id for update;
  if v_item.id is null or v_item.tenant_id <> NEW.tenant_id then
    raise exception 'That item is not in this school''s register' using errcode = '42501';
  end if;
  if v_item.tracking <> 'stock' then
    raise exception '% is a single tracked item; only stock lines take deliveries and use', v_item.name using errcode = '22023';
  end if;
  if v_item.retired_at is not null then
    raise exception '% has been written off', v_item.name using errcode = '23514';
  end if;

  v_delta := case NEW.kind when 'received' then NEW.quantity when 'adjusted' then NEW.quantity else -NEW.quantity end;
  if v_item.quantity + v_delta < 0 then
    raise exception 'Only % % of % in stock', v_item.quantity, coalesce(v_item.unit, 'left'), v_item.name using errcode = '23514';
  end if;
  if v_delta < 0 then
    select coalesce(sum(quantity), 0) into v_out from inventory_issues where item_id = NEW.item_id and status = 'out';
    if v_item.quantity + v_delta < v_out then
      raise exception '% of % are out with people; the stock cannot fall below that', v_out, v_item.name using errcode = '23514';
    end if;
  end if;

  NEW.supplier  := nullif(trim(coalesce(NEW.supplier, '')), '');
  NEW.reference := nullif(trim(coalesce(NEW.reference, '')), '');
  NEW.purpose   := nullif(trim(coalesce(NEW.purpose, '')), '');
  NEW.note      := nullif(trim(coalesce(NEW.note, '')), '');
  NEW.recorded_by := coalesce(auth.uid(), NEW.recorded_by);
  NEW.created_at  := now();

  update inventory_items
  set quantity = quantity + v_delta,
      -- the latest price is the item's price
      unit_cost_cents = case when NEW.kind = 'received' and NEW.unit_cost_cents is not null then NEW.unit_cost_cents else unit_cost_cents end
  where id = NEW.item_id;
  return NEW;
end;
$$;

create trigger inventory_movements_apply before insert or update on inventory_movements
  for each row execute function inventory_movements_apply();

create policy inventory_movements_read on inventory_movements for select
  using (is_super() or has_perm(tenant_id, 'inventory') or (tenant_id = my_tenant() and is_staff()));
-- No update or delete policy: a movement is never rewritten or removed.
create policy inventory_movements_insert on inventory_movements for insert
  with check (has_perm(tenant_id, 'inventory'));

-- Audited like the rest of the inventory (20261104000000).
insert into audit_table_config (table_name, category, keep_values) values ('inventory_movements', 'operations', true);
create trigger inventory_movements_audit_ins after insert on inventory_movements referencing new table as new_rows
  for each statement execute function audit_table_change('operations', 'true', 'id');

-- ================================================================ reports

-- Who may read a school's stock reports: the same people who read its
-- movements; and the server itself (the service role, or a database owner
-- at a psql prompt with no one signed in), which seeds and checks them.
create or replace function inventory_may_read(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    is_super() or has_perm(p_tenant_id, 'inventory') or (p_tenant_id = my_tenant() and is_staff())
    or auth.role() = 'service_role'
    or (auth.uid() is null and session_user in ('postgres', 'supabase_admin')),
    false)
$$;

-- What one unit of an item cost on a day: the latest priced delivery on or
-- before it, else the register's price.
-- Runs with the caller's rights: called directly, RLS decides what it sees.
create or replace function inventory_price_on(p_item_id uuid, p_day date) returns bigint
language sql stable set search_path = public as $$
  select coalesce(
    (select r.unit_cost_cents from inventory_movements r
      where r.item_id = p_item_id and r.kind = 'received' and r.unit_cost_cents is not null and r.occurred_on <= p_day
      order by r.occurred_on desc, r.created_at desc limit 1),
    (select unit_cost_cents from inventory_items where id = p_item_id))
$$;

-- "25 kg", "1 bag", "3 litres": a quantity and its unit as the flags write them.
create or replace function inventory_qty_text(p_qty numeric, p_unit text) returns text
language sql immutable set search_path = public as $$
  select trim_scale(round(p_qty, 2))::text || coalesce(' ' || case when abs(p_qty) = 1 then regexp_replace(p_unit, '([^s])s$', '\1') else p_unit end, '')
$$;

-- Everything that went in or out of a school's stock lines in a period: every
-- movement, and every medicine the sick bay gave from a Medical stock line
-- (visit_medications, 20261101300000), as 'used' for 'Sick bay' on the day it
-- was given (the school's time zone). The sick bay's own trigger already took
-- those off inventory_items.quantity, so they are never also recorded as
-- movements; this is where the reports count them. No learner, visit or
-- person comes out of it: an item, an amount and a day.
create or replace function inventory_ledger(p_tenant_id uuid, p_from date, p_to date)
returns table (item_id uuid, kind text, quantity int, occurred_on date, purpose text, meals_served int,
               unit_cost_cents bigint, supplier text, created_at timestamptz, source text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tz text;
begin
  if not inventory_may_read(p_tenant_id) then
    raise exception 'Only the school''s staff can see its stock reports' using errcode = '42501';
  end if;
  select coalesce(t.timezone, 'Africa/Nairobi') into v_tz from tenants t where t.id = p_tenant_id;
  return query
  select m.item_id, m.kind, m.quantity, m.occurred_on, m.purpose, m.meals_served, m.unit_cost_cents, m.supplier, m.created_at, 'movement'::text
  from inventory_movements m
  where m.tenant_id = p_tenant_id and m.occurred_on between p_from and p_to
  union all
  select vm.inventory_item_id, 'used'::text, vm.stock_quantity, (vm.given_at at time zone v_tz)::date, 'Sick bay'::text, null::int,
    null::bigint, null::text, vm.created_at, 'sick_bay'::text
  from visit_medications vm
  where vm.tenant_id = p_tenant_id and vm.inventory_item_id is not null and vm.stock_quantity is not null
    and vm.given_at >= (p_from::timestamp at time zone v_tz) and vm.given_at < ((p_to + 1)::timestamp at time zone v_tz);
end;
$$;

-- Use (sick-bay medicine included), waste, deliveries, shrinkage (stock-take
-- shortfalls) and money per item per period. p_bucket: 'day', 'week' (ISO,
-- from Monday), 'month' or 'year'.
create or replace function inventory_usage(p_tenant_id uuid, p_from date, p_to date, p_bucket text default 'week')
returns table (item_id uuid, period_start date, used bigint, wasted bigint, received bigint, shrinkage bigint,
               spend_cents bigint, used_cost_cents bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not inventory_may_read(p_tenant_id) then
    raise exception 'Only the school''s staff can see its stock reports' using errcode = '42501';
  end if;
  if p_bucket not in ('day', 'week', 'month', 'year') then
    raise exception 'p_bucket must be day, week, month or year' using errcode = '22023';
  end if;
  return query
  select m.item_id, date_trunc(p_bucket, m.occurred_on)::date,
    coalesce(sum(m.quantity) filter (where m.kind = 'used'), 0)::bigint,
    coalesce(sum(m.quantity) filter (where m.kind = 'wasted'), 0)::bigint,
    coalesce(sum(m.quantity) filter (where m.kind = 'received'), 0)::bigint,
    coalesce(-sum(m.quantity) filter (where m.kind = 'adjusted' and m.quantity < 0), 0)::bigint,
    coalesce(sum(m.quantity * m.unit_cost_cents) filter (where m.kind = 'received'), 0)::bigint,
    coalesce(sum(m.quantity * inventory_price_on(m.item_id, m.occurred_on)) filter (where m.kind = 'used'), 0)::bigint
  from inventory_ledger(p_tenant_id, p_from, p_to) m
  group by 1, 2
  order by 2, 1;
end;
$$;

-- What deliveries cost, month by month and store by store (inventory_items.category).
create or replace function inventory_spend_by_month(p_tenant_id uuid, p_from date, p_to date)
returns table (month date, category text, spend_cents bigint, deliveries int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not inventory_may_read(p_tenant_id) then
    raise exception 'Only the school''s staff can see its stock reports' using errcode = '42501';
  end if;
  return query
  select date_trunc('month', m.occurred_on)::date, i.category,
    coalesce(sum(m.quantity * m.unit_cost_cents), 0)::bigint,
    count(*)::int
  from inventory_movements m join inventory_items i on i.id = m.item_id
  where m.tenant_id = p_tenant_id and m.kind = 'received' and m.occurred_on between p_from and p_to
  group by 1, 2
  order by 1, 2;
end;
$$;

-- Kitchen food used (priced at the delivery price of the day) over meals
-- served, per period and purpose. Meals are counted once per day and purpose
-- (the largest meals_served recorded on that day's lines for it), since rice
-- and beans for the same lunch both say how many ate.
create or replace function inventory_cost_per_meal(p_tenant_id uuid, p_from date, p_to date, p_bucket text default 'month')
returns table (period_start date, purpose text, used_cost_cents bigint, meals_served bigint, cost_per_meal_cents numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not inventory_may_read(p_tenant_id) then
    raise exception 'Only the school''s staff can see its stock reports' using errcode = '42501';
  end if;
  if p_bucket not in ('day', 'week', 'month', 'year') then
    raise exception 'p_bucket must be day, week, month or year' using errcode = '22023';
  end if;
  return query
  with used as (
    select m.occurred_on as day, coalesce(m.purpose, 'Other') as purpose,
      sum(m.quantity * coalesce(inventory_price_on(m.item_id, m.occurred_on), 0)) as cost,
      max(m.meals_served) as meals
    from inventory_movements m join inventory_items i on i.id = m.item_id
    where m.tenant_id = p_tenant_id and m.kind = 'used' and i.category = 'kitchen'
      and m.occurred_on between p_from and p_to
    group by 1, 2
  )
  select date_trunc(p_bucket, u.day)::date, u.purpose, sum(u.cost)::bigint, coalesce(sum(u.meals), 0)::bigint,
    -- only days that recorded meals count towards the cost of a meal
    round(sum(u.cost) filter (where u.meals > 0) / nullif(sum(u.meals) filter (where u.meals > 0), 0), 2)
  from used u
  group by 1, 2
  order by 1, 2;
end;
$$;

-- Every live stock line as of a day: what's on hand and what it's worth, the
-- average daily use over the 28 days to then (sick-bay medicine included), how
-- many days that lasts, whether it is at or below its reorder level, and when
-- the next delivery usually comes (the last one plus the median gap between
-- deliveries in the 120 days before).
create or replace function inventory_stock_levels(p_tenant_id uuid, p_as_of date default current_date)
returns table (item_id uuid, name text, category text, unit text, consumable boolean, quantity int, reorder_level int,
               unit_cost_cents bigint, value_cents bigint, used_28d bigint, wasted_28d bigint, avg_daily_use numeric,
               days_of_cover numeric, low boolean, last_received_on date, next_delivery_on date)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not inventory_may_read(p_tenant_id) then
    raise exception 'Only the school''s staff can see its stock reports' using errcode = '42501';
  end if;
  return query
  with u as (
    select l.item_id,
      coalesce(sum(l.quantity) filter (where l.kind = 'used'), 0)::bigint as used,
      coalesce(sum(l.quantity) filter (where l.kind = 'wasted'), 0)::bigint as wasted
    from inventory_ledger(p_tenant_id, p_as_of - 27, p_as_of) l
    group by 1
  )
  select i.id, i.name, i.category, i.unit, i.consumable, i.quantity, i.reorder_level, i.unit_cost_cents,
    (i.quantity * coalesce(i.unit_cost_cents, 0))::bigint,
    coalesce(u.used, 0), coalesce(u.wasted, 0),
    round(coalesce(u.used, 0) / 28.0, 2),
    case when u.used > 0 then round(i.quantity / (u.used / 28.0), 1) end,
    i.reorder_level is not null and i.quantity <= i.reorder_level,
    d.last_on,
    (d.last_on + d.gap)::date
  from inventory_items i
  left join u on u.item_id = i.id
  cross join lateral (
    select max(r.day) as last_on,
           round(percentile_cont(0.5) within group (order by r.gap))::int as gap
    from (
      select x.day, x.day - lag(x.day) over (order by x.day) as gap
      from (select distinct m.occurred_on as day from inventory_movements m
            where m.item_id = i.id and m.kind = 'received' and m.occurred_on > p_as_of - 120 and m.occurred_on <= p_as_of) x
    ) r
  ) d
  where i.tenant_id = p_tenant_id and i.tracking = 'stock' and i.retired_at is null
  order by i.category, i.name;
end;
$$;

-- Mouths to feed on each day: learners on the roll then (archived ones
-- until the day they were archived), staff then (until they left or were
-- archived), and visitors who signed in at the gate that day (the school's
-- own time zone).
create or replace function inventory_headcount(p_tenant_id uuid, p_from date, p_to date)
returns table (day date, learners int, staff int, visitors int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tz text;
begin
  if not inventory_may_read(p_tenant_id) then
    raise exception 'Only the school''s staff can see its stock reports' using errcode = '42501';
  end if;
  if p_to - p_from > 400 then
    raise exception 'Ask for at most 400 days at a time' using errcode = '22023';
  end if;
  select coalesce(t.timezone, 'Africa/Nairobi') into v_tz from tenants t where t.id = p_tenant_id;
  return query
  with days as (select g::date as day from generate_series(p_from, p_to, interval '1 day') g),
  v as (
    select (vi.arrived_at at time zone v_tz)::date as day, count(*)::int as n
    from visits vi
    where vi.tenant_id = p_tenant_id
      and vi.arrived_at >= (p_from::timestamp at time zone v_tz) and vi.arrived_at < ((p_to + 1)::timestamp at time zone v_tz)
    group by 1
  )
  select d.day,
    (select count(*)::int from students s where s.tenant_id = p_tenant_id
       and ((s.archived_at is null and s.active) or (s.archived_at is not null and (s.archived_at at time zone v_tz)::date > d.day))),
    (select count(*)::int from profiles p where p.tenant_id = p_tenant_id and p.role not in ('parent', 'student')
       and (p.archived_at is null or (p.archived_at at time zone v_tz)::date > d.day)
       and (p.left_on is null or p.left_on > d.day)),
    coalesce(v.n, 0)
  from days d left join v on v.day = d.day
  order by d.day;
end;
$$;

-- The anomaly flags, worked out in SQL so they hold with AI switched off.
-- They cover every consumable store (kitchen, stationery and art, lab,
-- clinic...), with sick-bay medicine counted as use (inventory_ledger).
-- One row per finding; kind is one of:
--   usage_up / usage_down
--     Kitchen food, per DAY: a consumable's use for one purpose on one day,
--       against the median of the previous 4 days with use for the same
--       purpose and the same kind of day (weekday or weekend), per head.
--       Heads are meals_served when the day recorded it, else learners +
--       staff + visitors. Flagged when use per head moved more than 15% and
--       by at least one whole unit.
--     Every other store, per WEEK (Monday to Sunday, complete weeks only;
--       their use is lumpy): the week's use for one purpose against the
--       median of the previous 4 weeks with use, per unit of what drives it:
--       lab supplies per practical (a day the lab used it), clinic supplies
--       per sick-bay visit, anything else per head (the week's average of
--       learners + staff + visitors). Flagged when that moved more than 25%
--       and by at least one whole unit. occurred_on is the Sunday,
--       period_from the Monday.
--     Either way, a rise that the driver explains (use up past the
--       threshold, the driver up over 10%, use per unit within it) is still
--       listed, explained = true, severity 'low': the sports day shows as
--       normal, not an alarm.
--   usage_trend      kitchen food: use per head over the last 7 days to p_to
--       against the same 7 days three weeks earlier, a slow creep a
--       day-by-day baseline absorbs. Over 15% up (or explained, as above).
--   non_school_day   use or waste recorded on a day outside every term, or on
--       a weekend at a school with no boarders.
--   shrinkage        a consumable's stock-take that found stock missing beyond
--       normal waste (the waste of the 30 days before, or 2% of the use,
--       whichever is more).
--   price_jump       a delivery priced over 20% above the median of the last 4
--       priced deliveries of the item from that supplier (any supplier when
--       fewer than 2 from it).
--   run_out          a consumable that, at its average use, runs out before
--       its next usual delivery (or, with no delivery pattern, is at or
--       below its reorder level). Worked out for today, not p_to.
-- severity: 'high', 'medium' or 'low'. expected and actual are in the item's
-- unit (cents for price_jump, days for run_out); headcount and
-- baseline_headcount are the driver (heads, meals, practicals or sick-bay
-- visits). No person is named.
create or replace function inventory_consumption_flags(p_tenant_id uuid, p_from date, p_to date)
returns table (kind text, item_id uuid, item_name text, category text, unit text, purpose text, occurred_on date, period_from date,
               expected numeric, actual numeric, headcount int, baseline_headcount int, visitors int,
               severity text, explained boolean, reason text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_boarders boolean;
  v_tz text;
begin
  if not inventory_may_read(p_tenant_id) then
    raise exception 'Only the school''s staff can see its stock reports' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'Ask for at most a year, from before to' using errcode = '22023';
  end if;
  select exists (select 1 from students s where s.tenant_id = p_tenant_id and s.active and s.boarding) into v_boarders;
  select coalesce(t.timezone, 'Africa/Nairobi') into v_tz from tenants t where t.id = p_tenant_id;

  -- ------------------------------------------------ kitchen: daily use against its baseline
  return query
  with hc as (select * from inventory_headcount(p_tenant_id, p_from - 70, p_to)),
  daily as (
    select m.item_id, coalesce(m.purpose, '') as purpose, m.occurred_on as day,
      sum(m.quantity)::numeric as qty, max(m.meals_served) as meals
    from inventory_ledger(p_tenant_id, p_from - 70, p_to) m join inventory_items i on i.id = m.item_id
    where m.kind = 'used' and i.consumable and i.category = 'kitchen'
    group by 1, 2, 3
  ),
  d2 as (
    select d.*, coalesce(d.meals, h.learners + h.staff + h.visitors)::numeric as heads, (d.meals is not null) as by_meals,
      h.visitors, extract(isodow from d.day) >= 6 as weekend
    from daily d join hc h on h.day = d.day
  ),
  cmp as (
    select d.*, b.n, b.med_qty, b.med_heads, b.med_ph
    from d2 d
    cross join lateral (
      select count(*) as n,
        percentile_cont(0.5) within group (order by p.qty) as med_qty,
        percentile_cont(0.5) within group (order by p.heads) as med_heads,
        percentile_cont(0.5) within group (order by p.qty / p.heads) as med_ph
      from (select * from d2 p
            where p.item_id = d.item_id and p.purpose = d.purpose and p.day < d.day and p.weekend = d.weekend
              and p.by_meals = d.by_meals and p.heads > 0
            order by p.day desc limit 4) p
    ) b
    where d.day between p_from and p_to and b.n >= 3 and d.heads > 0 and b.med_ph > 0
  ),
  scored as (
    select c.*, (c.qty / c.heads) / c.med_ph::numeric - 1 as ph_change, c.qty / c.med_qty::numeric - 1 as qty_change,
      c.heads / c.med_heads::numeric - 1 as head_change
    from cmp c
  )
  -- an explained rise is a rise in use, whichever way use per head moved within the threshold
  select case when abs(s.ph_change) <= 0.15 or s.ph_change > 0 then 'usage_up' else 'usage_down' end,
    s.item_id, i.name, i.category, i.unit, nullif(s.purpose, ''), s.day, null::date,
    round(s.med_ph::numeric * s.heads, 1), s.qty, s.heads::int, round(s.med_heads::numeric)::int, s.visitors,
    case when abs(s.ph_change) <= 0.15 then 'low' when s.ph_change > 0.20 then 'high' when s.ph_change > 0 then 'medium' else 'low' end,
    abs(s.ph_change) <= 0.15,
    case when abs(s.ph_change) <= 0.15 then
      format('%s of %s used on %s against about %s usually, but %s rose too (%s to %s%s): use per head is normal.',
        inventory_qty_text(s.qty, i.unit), i.name || coalesce(' for ' || nullif(s.purpose, ''), ''), to_char(s.day, 'Dy DD Mon'),
        trim_scale(round(s.med_qty::numeric, 1)), case when s.by_meals then 'meals served' else 'headcount' end,
        to_char(s.med_heads, 'FM999,999,990'), to_char(s.heads, 'FM999,999,990'),
        case when s.visitors > 0 and not s.by_meals then format(', %s visitors', s.visitors) else '' end)
    else
      format('%s of %s used on %s against about %s expected; %s %s (%s to %s). Use per head %s %s%%.',
        inventory_qty_text(s.qty, i.unit), i.name || coalesce(' for ' || nullif(s.purpose, ''), ''), to_char(s.day, 'Dy DD Mon'),
        trim_scale(round(s.med_ph::numeric * s.heads, 1)),
        case when s.by_meals then 'meals served' else 'learners, staff and visitors' end,
        case when abs(s.head_change) < 0.05 then 'about the same' when s.head_change > 0 then 'up' else 'down' end,
        to_char(s.med_heads, 'FM999,999,990'), to_char(s.heads, 'FM999,999,990'),
        case when s.ph_change > 0 then 'up' else 'down' end, round(abs(s.ph_change) * 100))
    end
  from scored s join inventory_items i on i.id = s.item_id
  -- and at least one whole unit off what was expected: a bag of potatoes against 1.2 is not news
  where (abs(s.ph_change) > 0.15 and abs(s.qty - s.med_ph::numeric * s.heads) >= 1)
     or (abs(s.ph_change) <= 0.15 and s.qty_change > 0.15 and s.head_change > 0.10);

  -- ------------------------------------------------ every other store: weekly use against its baseline
  return query
  with hc as (
    select date_trunc('week', h.day)::date as wk, avg(h.learners + h.staff + h.visitors) filter (where extract(isodow from h.day) < 6) as heads,
      sum(h.visitors)::int as visitors
    from inventory_headcount(p_tenant_id, (date_trunc('week', p_from)::date - 70), p_to) h
    group by 1
  ),
  sbv as (
    select date_trunc('week', (v.time_in at time zone v_tz)::date)::date as wk, count(*)::numeric as n
    from sick_bay_visits v
    where v.tenant_id = p_tenant_id and v.time_in >= ((date_trunc('week', p_from)::date - 70)::timestamp at time zone v_tz)
    group by 1
  ),
  weekly as (
    select m.item_id, i.category, coalesce(m.purpose, '') as purpose, date_trunc('week', m.occurred_on)::date as wk,
      sum(m.quantity)::numeric as qty, count(distinct m.occurred_on)::numeric as use_days
    from inventory_ledger(p_tenant_id, date_trunc('week', p_from)::date - 70, p_to) m join inventory_items i on i.id = m.item_id
    where m.kind = 'used' and i.consumable and i.category <> 'kitchen'
    group by 1, 2, 3, 4
  ),
  w2 as (
    select w.*,
      case when w.category = 'lab_equipment' then w.use_days
           when w.category = 'medical' then coalesce(sv.n, w.use_days)
           else h.heads end::numeric as driver,
      case when w.category = 'lab_equipment' then 'practicals' when w.category = 'medical' and sv.n is not null then 'sick-bay visits'
           when w.category = 'medical' then 'days used' else 'learners, staff and visitors' end as driver_label,
      case when w.category in ('lab_equipment', 'medical') then null else h.visitors end as visitors
    from weekly w left join hc h on h.wk = w.wk left join sbv sv on sv.wk = w.wk
  ),
  cmp as (
    select w.*, b.n, b.med_qty, b.med_driver, b.med_pu
    from w2 w
    cross join lateral (
      select count(*) as n,
        percentile_cont(0.5) within group (order by p.qty) as med_qty,
        percentile_cont(0.5) within group (order by p.driver) as med_driver,
        percentile_cont(0.5) within group (order by p.qty / p.driver) as med_pu
      from (select * from w2 p
            where p.item_id = w.item_id and p.purpose = w.purpose and p.wk < w.wk and p.driver > 0
            order by p.wk desc limit 4) p
    ) b
    -- complete weeks that end in the period
    where w.wk + 6 between p_from and p_to and b.n >= 3 and w.driver > 0 and b.med_pu > 0
  ),
  scored as (
    select c.*, (c.qty / c.driver) / c.med_pu::numeric - 1 as pu_change, c.qty / c.med_qty::numeric - 1 as qty_change,
      c.driver / c.med_driver::numeric - 1 as driver_change
    from cmp c
  )
  select case when abs(s.pu_change) <= 0.25 or s.pu_change > 0 then 'usage_up' else 'usage_down' end,
    s.item_id, i.name, i.category, i.unit, nullif(s.purpose, ''), s.wk + 6, s.wk,
    round(s.med_pu::numeric * s.driver, 1), s.qty, round(s.driver)::int, round(s.med_driver::numeric)::int, s.visitors,
    case when abs(s.pu_change) <= 0.25 then 'low' when s.pu_change > 0.50 then 'high' when s.pu_change > 0 then 'medium' else 'low' end,
    abs(s.pu_change) <= 0.25,
    case when abs(s.pu_change) <= 0.25 then
      format('Week of %s: %s of %s used against about %s usually, but %s rose too (%s to %s): use per %s is normal.',
        to_char(s.wk, 'DD Mon'), inventory_qty_text(s.qty, i.unit), i.name || coalesce(' for ' || nullif(s.purpose, ''), ''),
        trim_scale(round(s.med_qty::numeric, 1)), s.driver_label,
        to_char(s.med_driver, 'FM999,999,990'), to_char(s.driver, 'FM999,999,990'),
        case s.driver_label when 'practicals' then 'practical' when 'sick-bay visits' then 'visit' when 'days used' then 'day' else 'head' end)
    else
      format('Week of %s: %s of %s used against about %s expected; %s %s (%s to %s). Use per %s %s %s%%.',
        to_char(s.wk, 'DD Mon'), inventory_qty_text(s.qty, i.unit), i.name || coalesce(' for ' || nullif(s.purpose, ''), ''),
        trim_scale(round(s.med_pu::numeric * s.driver, 1)), s.driver_label,
        case when abs(s.driver_change) < 0.05 then 'about the same' when s.driver_change > 0 then 'up' else 'down' end,
        to_char(s.med_driver, 'FM999,999,990'), to_char(s.driver, 'FM999,999,990'),
        case s.driver_label when 'practicals' then 'practical' when 'sick-bay visits' then 'visit' when 'days used' then 'day' else 'head' end,
        case when s.pu_change > 0 then 'up' else 'down' end, round(abs(s.pu_change) * 100))
    end
  from scored s join inventory_items i on i.id = s.item_id
  where (abs(s.pu_change) > 0.25 and abs(s.qty - s.med_pu::numeric * s.driver) >= 1)
     or (abs(s.pu_change) <= 0.25 and s.qty_change > 0.25 and s.driver_change > 0.10);

  -- ------------------------------------------------ kitchen: slow creep, last 7 days against 3 weeks before
  return query
  with hc as (select * from inventory_headcount(p_tenant_id, p_to - 27, p_to)),
  daily as (
    select m.item_id, m.occurred_on as day, sum(m.quantity)::numeric as qty
    from inventory_ledger(p_tenant_id, p_to - 27, p_to) m join inventory_items i on i.id = m.item_id
    where m.kind = 'used' and i.consumable and i.category = 'kitchen'
    group by 1, 2
  ),
  w as (
    select d.item_id, d.day > p_to - 7 as recent,
      sum(d.qty) as qty, sum(h.learners + h.staff + h.visitors)::numeric as heads, count(*) as days
    from daily d join hc h on h.day = d.day
    where d.day > p_to - 7 or d.day <= p_to - 21
    group by 1, 2
  ),
  t as (
    select r.item_id, r.qty / r.days as qty_now, e.qty / e.days as qty_then, r.heads / r.days as heads_now, e.heads / e.days as heads_then,
      (r.qty / r.heads) / (e.qty / e.heads) - 1 as ph_change, (r.heads / r.days) / (e.heads / e.days) - 1 as head_change
    from w r join w e on e.item_id = r.item_id and not e.recent
    where r.recent and r.days >= 3 and e.days >= 3 and r.heads > 0 and e.heads > 0 and e.qty > 0
  )
  select 'usage_trend', t.item_id, i.name, i.category, i.unit, null::text, p_to, p_to - 27,
    round(t.qty_then * (t.heads_now / t.heads_then), 1), round(t.qty_now, 1), round(t.heads_now)::int, round(t.heads_then)::int, null::int,
    case when t.ph_change <= 0.15 then 'low' when t.ph_change > 0.30 then 'high' else 'medium' end,
    t.ph_change <= 0.15,
    format('%s use has crept up: about %s a day this week against %s three weeks ago, with headcount %s (%s to %s). Use per head up %s%%.',
      i.name, inventory_qty_text(round(t.qty_now, 1), i.unit), trim_scale(round(t.qty_then, 1)),
      case when abs(t.head_change) < 0.05 then 'about the same' when t.head_change > 0 then 'up' else 'down' end,
      to_char(round(t.heads_then), 'FM999,999,990'), to_char(round(t.heads_now), 'FM999,999,990'), round(t.ph_change * 100))
  from t join inventory_items i on i.id = t.item_id
  where t.ph_change > 0.15 or (t.qty_now / t.qty_then - 1 > 0.15 and t.head_change > 0.10);

  -- ------------------------------------------------ use on a day the school is shut
  return query
  select 'non_school_day', m.item_id, i.name, i.category, i.unit, max(m.purpose), m.occurred_on, null::date,
    0::numeric, sum(m.quantity)::numeric, null::int, null::int, null::int,
    'medium', false,
    format('%s of %s recorded as %s on %s, %s.', inventory_qty_text(sum(m.quantity), i.unit), i.name,
      string_agg(distinct m.kind, ' and '), to_char(m.occurred_on, 'Dy DD Mon'),
      case when not exists (select 1 from terms t where t.tenant_id = p_tenant_id and m.occurred_on between t.starts_on and t.ends_on)
        then 'which is outside every term' else 'a weekend, and the school has no boarders' end)
  from inventory_ledger(p_tenant_id, p_from, p_to) m join inventory_items i on i.id = m.item_id
  where m.kind in ('used', 'wasted')
    and (not exists (select 1 from terms t where t.tenant_id = p_tenant_id and m.occurred_on between t.starts_on and t.ends_on)
         or (extract(isodow from m.occurred_on) >= 6 and not v_boarders))
  group by m.item_id, i.name, i.category, i.unit, m.occurred_on;

  -- ------------------------------------------------ stock-take shortfalls beyond normal waste
  return query
  with l as (select * from inventory_ledger(p_tenant_id, p_from - 30, p_to)),
  a as (
    select m.*,
      (select coalesce(sum(x.quantity), 0) from inventory_movements x
        where x.item_id = m.item_id and x.kind = 'wasted' and x.occurred_on between m.occurred_on - 30 and m.occurred_on) as waste30,
      (select coalesce(sum(x.quantity), 0) from l x
        where x.item_id = m.item_id and x.kind = 'used' and x.occurred_on between m.occurred_on - 30 and m.occurred_on) as use30
    from inventory_movements m join inventory_items i on i.id = m.item_id
    where m.tenant_id = p_tenant_id and m.kind = 'adjusted' and m.quantity < 0 and i.consumable
      and m.occurred_on between p_from and p_to
  ),
  b as (select a.*, greatest(a.waste30, ceil(a.use30 * 0.02)) as allowance from a)
  select 'shrinkage', b.item_id, i.name, i.category, i.unit, null::text, b.occurred_on, b.occurred_on - 30,
    b.allowance::numeric, (-b.quantity)::numeric, null::int, null::int, null::int,
    case when -b.quantity > 2 * b.allowance then 'high' else 'medium' end, false,
    format('Stock-take on %s found %s of %s short; normal waste over the month before was about %s.',
      to_char(b.occurred_on, 'Dy DD Mon'), inventory_qty_text(-b.quantity, i.unit), i.name, inventory_qty_text(b.allowance, i.unit))
  from b join inventory_items i on i.id = b.item_id
  where -b.quantity > b.allowance;

  -- ------------------------------------------------ a delivery priced well above the usual
  return query
  with r as (
    select m.*,
      (select count(*) from (select 1 from inventory_movements x where x.item_id = m.item_id and x.kind = 'received'
          and x.unit_cost_cents is not null and lower(x.supplier) = lower(m.supplier)
          and (x.occurred_on, x.created_at) < (m.occurred_on, m.created_at) limit 4) q) as same_n
    from inventory_movements m
    where m.tenant_id = p_tenant_id and m.kind = 'received' and m.unit_cost_cents is not null and m.occurred_on between p_from and p_to
  ),
  b as (
    select r.*, (
      select percentile_cont(0.5) within group (order by p.unit_cost_cents)
      from (select x.unit_cost_cents from inventory_movements x
            where x.item_id = r.item_id and x.kind = 'received' and x.unit_cost_cents is not null
              and (x.occurred_on, x.created_at) < (r.occurred_on, r.created_at)
              and (r.same_n < 2 or lower(x.supplier) = lower(r.supplier))
            order by x.occurred_on desc, x.created_at desc limit 4) p
    ) as usual
    from r
  )
  select 'price_jump', b.item_id, i.name, i.category, i.unit, null::text, b.occurred_on, null::date,
    round(b.usual::numeric), b.unit_cost_cents::numeric, null::int, null::int, null::int,
    case when b.unit_cost_cents > b.usual * 1.4 then 'high' else 'medium' end, false,
    format('%s delivered on %s%s at %s a %s, %s%% above the usual %s.',
      i.name, to_char(b.occurred_on, 'Dy DD Mon'), coalesce(' by ' || b.supplier, ''),
      trim_scale(round(b.unit_cost_cents / 100.0, 2)), coalesce(regexp_replace(i.unit, '([^s])s$', '\1'), 'unit'),
      round((b.unit_cost_cents / b.usual::numeric - 1) * 100), trim_scale(round(b.usual::numeric / 100, 2)))
  from b join inventory_items i on i.id = b.item_id
  where b.usual > 0 and b.unit_cost_cents > b.usual * 1.2;

  -- ------------------------------------------------ running out before the next delivery
  return query
  select 'run_out', l.item_id, l.name, l.category, l.unit, null::text, current_date, null::date,
    (l.next_delivery_on - current_date)::numeric, l.days_of_cover, null::int, null::int, null::int,
    case when coalesce(l.days_of_cover, 0) < 3 then 'high' else 'medium' end, false,
    case when l.next_delivery_on is not null and l.days_of_cover is not null
           and current_date + floor(l.days_of_cover)::int < l.next_delivery_on then
      format('%s of %s left lasts about %s days at %s a day; the next delivery usually comes on %s. Reorder now.',
        inventory_qty_text(l.quantity, l.unit), l.name, trim_scale(l.days_of_cover), inventory_qty_text(round(l.avg_daily_use, 1), l.unit),
        to_char(l.next_delivery_on, 'Dy DD Mon'))
    else
      format('%s is at %s, at or below its reorder level of %s.', l.name, inventory_qty_text(l.quantity, l.unit), inventory_qty_text(l.reorder_level, l.unit))
    end
  from inventory_stock_levels(p_tenant_id, current_date) l
  where l.consumable and (
    (l.next_delivery_on is not null and l.days_of_cover is not null and current_date + floor(l.days_of_cover)::int < l.next_delivery_on)
    or ((l.next_delivery_on is null or l.days_of_cover is null) and l.low));
end;
$$;

revoke execute on function inventory_ledger(uuid, date, date) from public, anon;
revoke execute on function inventory_usage(uuid, date, date, text) from public, anon;
revoke execute on function inventory_spend_by_month(uuid, date, date) from public, anon;
revoke execute on function inventory_cost_per_meal(uuid, date, date, text) from public, anon;
revoke execute on function inventory_stock_levels(uuid, date) from public, anon;
revoke execute on function inventory_headcount(uuid, date, date) from public, anon;
revoke execute on function inventory_consumption_flags(uuid, date, date) from public, anon;
revoke execute on function inventory_price_on(uuid, date) from public, anon;
revoke execute on function inventory_qty_text(numeric, text) from public, anon;
grant execute on function inventory_ledger(uuid, date, date) to authenticated, service_role;
grant execute on function inventory_usage(uuid, date, date, text) to authenticated, service_role;
grant execute on function inventory_spend_by_month(uuid, date, date) to authenticated, service_role;
grant execute on function inventory_cost_per_meal(uuid, date, date, text) to authenticated, service_role;
grant execute on function inventory_stock_levels(uuid, date) to authenticated, service_role;
grant execute on function inventory_headcount(uuid, date, date) to authenticated, service_role;
grant execute on function inventory_consumption_flags(uuid, date, date) to authenticated, service_role;
grant execute on function inventory_price_on(uuid, date) to authenticated, service_role;
grant execute on function inventory_qty_text(numeric, text) to authenticated, service_role;

-- ================================================================ AI insights

-- ai-assist's new "stock_insights" task is metered like every other task: one
-- ai_usage row per request (who, task, tokens; never the prompt or reply).
alter table ai_usage drop constraint ai_usage_task_check;
alter table ai_usage add constraint ai_usage_task_check
  check (task in ('report_comment', 'questions', 'homework', 'message', 'translate', 'tutor', 'chat', 'paper_import', 'guide', 'stock_insights'));
