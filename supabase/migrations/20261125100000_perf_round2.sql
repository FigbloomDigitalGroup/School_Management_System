-- Performance, round 2: what the production smoke test after 20261124300000_rls_once_per_query
-- still found slow or timing out on a full school (Kijani Ridge: ~980 learners, 170k attendance
-- rows, 60k marks, 8.7k stock movements, 2.4k uniform issues).
--
-- Who can see or change what is exactly as before. Policies are changed with ALTER POLICY (names,
-- commands and roles stay), in the same way as 20261124300000; functions keep their signatures
-- and return the same rows.
--
-- The four attendance migrations of 2026-11-10 (20261110160000 to 20261110190000) define
-- functions and triggers that nothing here touches, so this applies the same with or without them.

-- ================================================================ sports and activities
--
-- activity_members_write (FOR ALL, so ORed into every read) called may_manage_activity(activity_id)
-- on every row, and the read policies has_perm(tenant_id, 'activities'): a teacher counting the
-- members of a school's clubs (2.4k rows) passed the 8 s statement timeout.
--
--   may_manage_activity(a)        becomes  a in (select my_managed_activity_ids())
--   may_manage_activity_event(e)  becomes  e in (select my_managed_activity_event_ids())
--   has_perm(t, 'activities')     becomes  (select is_super()) or t in (select my_perm_tenant_ids('activities'))
--
-- The two set-returning functions are may_manage_activity / may_manage_activity_event read as
-- sets: the activities (events) for which those return true. supabase/rls-checks/activities_once_per_query.sql
-- asserts they agree for every kind of caller. If those functions change, change these with them.

-- The activities may_manage_activity(id) is true for.
create or replace function my_managed_activity_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select a.id from activities a
   where is_super()
      or a.tenant_id in (select my_perm_tenant_ids('activities'))
      or (a.tenant_id = my_tenant() and my_role() = 'teacher'
          and exists (select 1 from activity_patrons p where p.activity_id = a.id and p.teacher_id = auth.uid()))
$$;

-- The events may_manage_activity_event(id) is true for.
create or replace function my_managed_activity_event_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select e.id from activity_events e where e.activity_id in (select my_managed_activity_ids())
$$;

alter policy activities_read on activities using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('activities'))
  or tenant_id = (select my_tenant())
);

alter policy activities_insert on activities
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('activities')));

alter policy activities_update on activities
  using (id in (select my_managed_activity_ids()))
  with check (id in (select my_managed_activity_ids()));

alter policy activities_delete on activities
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('activities')));

alter policy activity_patrons_read on activity_patrons using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('activities'))
  or tenant_id = (select my_tenant())
);

alter policy activity_patrons_write on activity_patrons
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('activities')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('activities')));

alter policy activity_events_read on activity_events using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('activities'))
  or tenant_id = (select my_tenant())
);

alter policy activity_events_write on activity_events
  using (activity_id in (select my_managed_activity_ids()))
  with check (activity_id in (select my_managed_activity_ids()));

alter policy activity_members_read on activity_members using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('activities'))
  or (tenant_id = (select my_tenant()) and ((select is_staff()) or student_id in (select my_students())))
);

alter policy activity_members_write on activity_members
  using (activity_id in (select my_managed_activity_ids()))
  with check (activity_id in (select my_managed_activity_ids()));

alter policy activity_event_participants_read on activity_event_participants using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('activities'))
  or (tenant_id = (select my_tenant()) and ((select is_staff()) or student_id in (select my_students())))
);

alter policy activity_event_participants_write on activity_event_participants
  using (event_id in (select my_managed_activity_event_ids()))
  with check (event_id in (select my_managed_activity_event_ids()));

-- ================================================================ stock reports
--
-- inventory_usage priced every day's use with inventory_price_on(item, day), which looks up the
-- item's latest priced delivery on or before that day; with no index on item_id it scanned the
-- school's movements each time (a year of kitchen use: ~8 s locally, 15 s in production).
create index if not exists inventory_movements_received_price_idx
  on inventory_movements (item_id, occurred_on desc, created_at desc)
  where kind = 'received' and unit_cost_cents is not null;

-- inventory_headcount counted the school's learners and staff by scanning students and profiles
-- once for every day asked for. Now each is read once and counted per day: same rows.
create or replace function inventory_headcount(p_tenant_id uuid, p_from date, p_to date)
 RETURNS TABLE(day date, learners integer, staff integer, visitors integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  ),
  -- the school's learners and staff read once, then counted for each day
  st as materialized (
    select s.archived_at is null as current, (s.archived_at at time zone v_tz)::date as archived_on
    from students s
    where s.tenant_id = p_tenant_id and ((s.archived_at is null and s.active) or s.archived_at is not null)
  ),
  pr as materialized (
    select (p.archived_at at time zone v_tz)::date as archived_on, p.left_on
    from profiles p
    where p.tenant_id = p_tenant_id and p.role not in ('parent', 'student')
  )
  select d.day,
    (select count(*)::int from st where st.current or st.archived_on > d.day),
    (select count(*)::int from pr
      where (pr.archived_on is null or pr.archived_on > d.day) and (pr.left_on is null or pr.left_on > d.day)),
    coalesce(v.n, 0)
  from days d left join v on v.day = d.day
  order by d.day;
end;
$function$;

-- inventory_consumption_flags compared each day (kitchen) or week (other stores) with the 4
-- before it by scanning every other day of the period for each one: quadratic, ~7 s for a year.
-- The 4 before now come from a window over the same rows (one row per item, purpose and day or
-- week, so "the 4 rows before" are exactly the 4 days or weeks the old subquery picked), and the
-- medians are taken over those. Everything else is unchanged: same flags, same wording.
create or replace function inventory_consumption_flags(p_tenant_id uuid, p_from date, p_to date)
 RETURNS TABLE(kind text, item_id uuid, item_name text, category text, unit text, purpose text, occurred_on date, period_from date, expected numeric, actual numeric, headcount integer, baseline_headcount integer, visitors integer, severity text, explained boolean, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- the baseline: the 4 days before, of the same item, purpose, kind of day and count, with a
  -- headcount (one row per item, purpose and day, so the frame is exactly those days)
  d3 as (
    select d.*,
      array_agg(d.qty) over w as b_qty, array_agg(d.heads) over w as b_heads, array_agg(d.qty / d.heads) over w as b_ph
    from d2 d
    where d.heads > 0
    window w as (partition by d.item_id, d.purpose, d.weekend, d.by_meals order by d.day rows between 4 preceding and 1 preceding)
  ),
  cmp as (
    select d.*, b.n, b.med_qty, b.med_heads, b.med_ph
    from d3 d
    cross join lateral (
      select count(*) as n,
        percentile_cont(0.5) within group (order by p.qty) as med_qty,
        percentile_cont(0.5) within group (order by p.heads) as med_heads,
        percentile_cont(0.5) within group (order by p.ph) as med_ph
      from unnest(d.b_qty, d.b_heads, d.b_ph) p(qty, heads, ph)
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
  -- the baseline: the 4 weeks before, of the same item and purpose, with a driver
  w3 as (
    select w.*,
      array_agg(w.qty) over win as b_qty, array_agg(w.driver) over win as b_driver, array_agg(w.qty / w.driver) over win as b_pu
    from w2 w
    where w.driver > 0
    window win as (partition by w.item_id, w.purpose order by w.wk rows between 4 preceding and 1 preceding)
  ),
  cmp as (
    select w.*, b.n, b.med_qty, b.med_driver, b.med_pu
    from w3 w
    cross join lateral (
      select count(*) as n,
        percentile_cont(0.5) within group (order by p.qty) as med_qty,
        percentile_cont(0.5) within group (order by p.driver) as med_driver,
        percentile_cont(0.5) within group (order by p.pu) as med_pu
      from unnest(w.b_qty, w.b_driver, w.b_pu) p(qty, driver, pu)
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
$function$;

-- ================================================================ the caller's learners
--
-- my_students() and my_family_students() sit inside most read policies (students, attendance,
-- inventory, activities, ...). Their bodies called my_tenant(), is_staff() and is_org_admin() on
-- every row and, because of the OR between the school branch and the group-admin branch, read
-- every learner of every school: once per statement is still a full scan of all schools'
-- learners with three function calls a row, several times in a query with embeds (a learner's
-- own uniform issues with their item, learner and holder embedded: 7-8 s in production).
-- Same sets, each branch now an index read with the caller's rights worked out once.

create or replace function my_students() returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.id from students s
   where s.tenant_id = (select my_tenant())
     and ((select is_staff())
          or s.id in (select g.student_id from guardians g where g.profile_id = (select auth.uid()))
          or s.profile_id = (select auth.uid()))
  union
  select s.id from students s
   where (select is_org_admin()) and s.tenant_id in (select my_organization_tenant_ids())
$$;

create or replace function my_family_students() returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.id from students s
   where s.tenant_id = (select my_tenant())
     and (s.id in (select g.student_id from guardians g where g.profile_id = (select auth.uid()))
          or s.profile_id = (select auth.uid()))
  union
  select s.id from students s
   where (select is_org_admin()) and s.tenant_id in (select my_organization_tenant_ids())
$$;

-- ================================================================ inventory items
--
-- A family member or learner sees an item they (or their learner) hold. That was a correlated
-- EXISTS on inventory_issues per item (a scan of the school's issues for each one); now the set
-- of held items is read once.
alter policy inventory_items_read on inventory_items using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('inventory'))
  or (tenant_id = (select my_tenant()) and (select is_staff()))
  or id in (select i.item_id from inventory_issues i
             where i.profile_id = (select auth.uid()) or i.student_id in (select my_students()))
);

-- ================================================================ performance
--
-- The Performance page (per class: class_exam_performance, class_learner_exam_means, published
-- CBE judgements, the roster) and the marks policies look marks up by learner, but marks had no
-- index that starts with student_id (only (exam_id, student_id, subject_id)), so each learner's
-- marks were a scan of the whole index; learners by class and classes by class teacher had none
-- either.
create index if not exists marks_student_id_exam_id_idx on marks (student_id, exam_id);
create index if not exists students_class_id_idx on students (class_id) where class_id is not null;
create index if not exists classes_class_teacher_id_idx on classes (class_teacher_id) where class_teacher_id is not null;

-- class_learner_exam_means checked has_perm per learner row and marks_published per mark; the
-- right to see the class is now worked out once per school, and "published" is a semi-join on
-- mark_publications (its key is exam, class, subject). Same rows.
create or replace function class_learner_exam_means(p_class_id uuid)
returns table (exam_id uuid, student_id uuid, full_name text, mean_score numeric, subjects integer)
language sql stable security definer set search_path = public as $$
  select m.exam_id, s.id, s.full_name, round(avg(m.score), 1), count(*)::int
    from students s
    join marks m on m.student_id = s.id
   where s.class_id = p_class_id
     and s.active
     and m.score is not null
     and (m.exam_id, m.subject_id) in (select mp.exam_id, mp.subject_id from mark_publications mp where mp.class_id = p_class_id)
     and s.tenant_id in (select t.tenant_id from (select distinct s2.tenant_id from students s2 where s2.class_id = p_class_id) t
                          where has_perm(t.tenant_id, 'academics') or (t.tenant_id = my_tenant() and is_staff()))
   group by m.exam_id, s.id, s.full_name
$$;

-- ================================================================ the rest still checked per row
--
-- The remaining read (and FOR ALL) policies on tables with hundreds of rows a school or more that
-- still called a permission function per row, rewritten in the forms of 20261124300000:
-- CBE strand comments (~14k rows here), timetable slots, the audit log and strands.

alter policy cbe_comment_read on cbe_assessment_comments using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('academics'))
  or (tenant_id = (select my_tenant()) and (select is_staff()))
  or (student_id in (select my_students())
      and assessment_id in (select a.id from cbe_assessments a where a.published_at is not null))
);

-- (may_assess spelled out inside the subquery over assessments, as cbe_result_write)
alter policy cbe_comment_write on cbe_assessment_comments
  using (assessment_id in (
    select a.id from cbe_assessments a
     where (select is_super())
        or a.tenant_id in (select my_perm_tenant_ids('academics'))
        or (a.tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
            and (a.class_id, a.subject_id) in (select p.class_id, p.subject_id from my_teaching_pairs() p))))
  with check (assessment_id in (
    select a.id from cbe_assessments a
     where (select is_super())
        or a.tenant_id in (select my_perm_tenant_ids('academics'))
        or (a.tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
            and (a.class_id, a.subject_id) in (select p.class_id, p.subject_id from my_teaching_pairs() p))));

alter policy timetable_read on timetable_slots using (
  (select is_super())
  or tenant_id = (select my_tenant())
  or tenant_id in (select my_perm_tenant_ids('academics'))
);

alter policy timetable_write on timetable_slots
  using (
    (select is_super())
    or (tenant_id = (select my_tenant()) and (select my_role()) = 'school_admin'::app_role)
    or tenant_id in (select my_perm_tenant_ids('academics')))
  with check (
    (select is_super())
    or (tenant_id = (select my_tenant()) and (select my_role()) = 'school_admin'::app_role)
    or tenant_id in (select my_perm_tenant_ids('academics')));

alter policy audit_read on audit_events using (
  (select is_super()) or tenant_id in (select my_perm_tenant_ids('audit'))
);

alter policy strand_read on strands using (
  tenant_id is null
  or tenant_id = (select my_tenant())
  or (select is_super())
  or tenant_id in (select my_perm_tenant_ids('academics'))
);

alter policy strand_write_official on strands
  using (tenant_id is null and (select is_super()))
  with check (tenant_id is null and (select is_super()));

alter policy strand_write_school on strands
  using (tenant_id is not null and ((select is_super()) or tenant_id in (select my_perm_tenant_ids('academics'))))
  with check (tenant_id is not null and ((select is_super()) or tenant_id in (select my_perm_tenant_ids('academics'))));
