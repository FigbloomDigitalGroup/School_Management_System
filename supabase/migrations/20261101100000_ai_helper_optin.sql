-- The study helper by parent opt-in, and (switched off) billing it to the
-- family's fee invoice.
--
-- Until now the study helper ("Bloom study helper", ai-assist task 'tutor')
-- was one school-wide switch, tenants.ai_tutor_enabled: on, every learner at
-- the school could use it. Schools asked for two things: to let each family
-- decide, and later to pass the cost on to the families who choose it, as a
-- line on the learner's school fee invoice. The first is built here and
-- live. The second is built here and switched off: nobody is charged and
-- nothing asks for payment until a later migration turns it on (see "Turning
-- billing on" below).
--
--   tenants.ai_tutor_access          'all' (every learner, the behaviour until
--                                    now and the default) or 'opt_in' (only
--                                    learners whose parent or guardian has
--                                    turned it on)
--   tenants.ai_helper_price_cents    the price per learner per term, for when
--                                    billing is on. Stored now so a school can
--                                    set it; charged to nobody yet.
--   tenants.ai_helper_billing_enabled
--                                    charge opted-in learners' invoices. Held
--                                    false by a check constraint, and
--                                    set_ai_helper_settings refuses it, so it
--                                    can't be turned on through the API.
--   tenants.ai_helper_cancel_days    the cut-off: a parent who turns the helper
--                                    off within this many days of being charged
--                                    has the charge cancelled; after it, the
--                                    helper goes off and the charge stands
--   ai_helper_optins                 one row per learner: on or off, the term it
--                                    was last changed in, who turned it on and
--                                    when, who last changed it and when. Either
--                                    guardian of a learner may change it.
--   ai_helper_optin_log              every change, append-only: who, when, term
--   ai_helper_charges                which fee charge is a learner's study helper
--                                    charge for a term: the one-charge-per-
--                                    learner-per-term rule (primary key)
--
-- Who may use the helper (ai_helper_allowed, called by ai-assist for task
-- 'tutor'): the school has Bloom and the study helper on, AND (access is
-- 'all' OR the learner has an active opt-in), AND ai_tutor_blocked() says no
-- exam is in the way. With access 'all' that is exactly the old rule. An
-- opt-in is active while it is 'on'; once billing is on it also has to be
-- for the current term, so each term is chosen (and charged) afresh.
--
-- Billing (ai_helper_bill_optin): called by set_ai_helper_optin after a
-- change, only when the school's billing is on, and it checks that again
-- itself. Turning on adds a fee charge for the price, "Bloom study helper,
-- Term N", to the learner's current-term invoice, through fee_charges
-- (20261028200001), so every balance already includes it. Idempotent: a
-- learner already charged for the term isn't charged again. Turning off
-- within ai_helper_cancel_days of the charge cancels it (unless it has been
-- paid for: there is no refund flow, so the office handles that), after it
-- the charge stands. A learner who hasn't been billed for the term can't be
-- turned on while billing is on: the error rolls the opt-in back too.
--
-- Turning billing on (a later migration, plus one constant):
--   1. create or replace ai_helper_billing_available() to return true
--   2. alter table tenants drop constraint tenants_ai_helper_billing_off
--   3. AI_HELPER_BILLING_AVAILABLE = true in packages/shared/src/aiHelper.ts,
--      which shows the switch in AI settings and the price to parents
--   Then each school turns it on, with a price, in AI settings.
--
-- The office: ai_helper_roster lists the learners with an opt-in or this
-- month's study helper use, for full admins and the 'fees' area
-- (20261031000000). AI settings themselves stay full admins only
-- (may_administer), like set_ai_settings.
--
-- Recreated: nothing. ai_tutor_blocked, set_ai_settings and ai_status are
-- called or left as they are (20261030100000, 20261029100000).

-- ---------------------------------------------------------------- the school's settings
alter table tenants
  add column ai_tutor_access text not null default 'all'
    constraint tenants_ai_tutor_access_known check (ai_tutor_access in ('all', 'opt_in')),
  -- KES 100,000 a term is far above any sensible price; it catches a typo of extra zeros
  add column ai_helper_price_cents bigint not null default 0
    constraint tenants_ai_helper_price_range check (ai_helper_price_cents between 0 and 10000000),
  add column ai_helper_billing_enabled boolean not null default false,
  add column ai_helper_cancel_days int not null default 7
    constraint tenants_ai_helper_cancel_days_range check (ai_helper_cancel_days between 0 and 60);

-- Billing is built but not available: nothing, not even a super admin
-- writing the row directly, can turn it on until a migration drops this.
alter table tenants
  add constraint tenants_ai_helper_billing_off check (ai_helper_billing_enabled = false);

-- Whether charging for the study helper may be switched on at all. The one
-- place set_ai_helper_settings asks; the migration that turns billing on
-- makes it return true.
create or replace function ai_helper_billing_available() returns boolean
language sql immutable set search_path = public as $$
  select false
$$;

-- ---------------------------------------------------------------- tables
create table ai_helper_optins (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  student_id   uuid not null unique references students on delete cascade,
  status       text not null check (status in ('on', 'off')),
  -- the current term when it was last changed; null when the school had none
  term_id      uuid references terms on delete set null,
  -- who last turned it on, and when; kept while it is off
  turned_on_by uuid references profiles on delete set null,
  turned_on_at timestamptz,
  changed_by   uuid references profiles on delete set null,
  changed_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index on ai_helper_optins (tenant_id);

create table ai_helper_optin_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  student_id uuid not null references students on delete cascade,
  status     text not null check (status in ('on', 'off')),
  term_id    uuid references terms on delete set null,
  changed_by uuid references profiles on delete set null,
  -- the wall clock, not the transaction's start, so changes keep their order
  changed_at timestamptz not null default clock_timestamp()
);
create index on ai_helper_optin_log (student_id, changed_at desc);
create index on ai_helper_optin_log (tenant_id);

create table ai_helper_charges (
  tenant_id  uuid not null references tenants on delete cascade,
  student_id uuid not null references students on delete cascade,
  term_id    uuid not null references terms on delete cascade,
  -- the latest charge; a cancelled one is replaced if the helper is turned on again
  charge_id  uuid not null references fee_charges on delete cascade,
  created_at timestamptz not null default now(),
  primary key (student_id, term_id)
);
create index on ai_helper_charges (tenant_id);

alter table ai_helper_optins enable row level security;
alter table ai_helper_optin_log enable row level security;
alter table ai_helper_charges enable row level security;

-- The learner's guardians, the learner, and the office's fees area read a
-- learner's choice and its history. No write policies: set_ai_helper_optin()
-- is the only way in.
create policy ai_helper_optins_read on ai_helper_optins for select
  using (has_perm(tenant_id, 'fees')
         or exists (select 1 from guardians g where g.student_id = ai_helper_optins.student_id and g.profile_id = auth.uid())
         or exists (select 1 from students s where s.id = ai_helper_optins.student_id and s.profile_id = auth.uid()));
create policy ai_helper_optin_log_read on ai_helper_optin_log for select
  using (has_perm(tenant_id, 'fees')
         or exists (select 1 from guardians g where g.student_id = ai_helper_optin_log.student_id and g.profile_id = auth.uid()));
-- The charge itself is a fee_charges row, readable by whoever reads the invoice.
create policy ai_helper_charges_read on ai_helper_charges for select
  using (has_perm(tenant_id, 'fees'));

-- ---------------------------------------------------------------- who may use it
-- Why this learner can't use the study helper right now, or null when they
-- can: {code, message}. code 'school_off' (Bloom or the study helper is off),
-- 'needs_optin' (the school asks for a parent's opt-in and there isn't an
-- active one) or 'exam' (ai_tutor_blocked's reason). With ai_tutor_access
-- 'all' it answers exactly as the study helper switch and ai_tutor_blocked
-- did before. packages/shared/src/aiHelper.ts helperRefusal() mirrors it.
create or replace function ai_helper_allowed(p_profile_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t         tenants;
  v_blocked text;
begin
  select tn.* into t from tenants tn join profiles p on p.tenant_id = tn.id where p.id = p_profile_id;
  if t.id is null or not t.ai_enabled or not t.ai_tutor_enabled then
    return jsonb_build_object('code', 'school_off', 'message', 'Bloom isn''t turned on for learners at your school.');
  end if;
  if t.ai_tutor_access = 'opt_in' and not exists (
    select 1 from ai_helper_optins o
      join students s on s.id = o.student_id
     where s.profile_id = p_profile_id and s.active and s.tenant_id = t.id
       and o.status = 'on'
       and (not t.ai_helper_billing_enabled
            or o.term_id = (select tm.id from terms tm where tm.tenant_id = t.id and tm.is_current))
  ) then
    return jsonb_build_object('code', 'needs_optin', 'message',
      'Ask your parent or guardian to turn on the study helper for you (in their Figbloom app).');
  end if;
  v_blocked := ai_tutor_blocked(p_profile_id);
  if v_blocked is not null then
    return jsonb_build_object('code', 'exam', 'message', v_blocked);
  end if;
  return null;
end $$;
revoke execute on function ai_helper_allowed(uuid) from public, anon, authenticated;
grant execute on function ai_helper_allowed(uuid) to service_role;

-- ---------------------------------------------------------------- billing (off until ai_helper_billing_available())
-- What a change to a learner's opt-in does to their fees, when the school
-- bills for the study helper. Answers what it did:
--   billing_off        the school doesn't bill for it (every school, for now)
--   free               access is 'all', or the price is 0
--   charged            turned on: the term's charge was added
--   already_charged    turned on, and this term's charge already stands
--   cancelled          turned off before the cut-off: the charge was cancelled
--   kept               turned off after the cut-off, or the charge is already
--                      paid for: the charge stands
--   nothing_to_cancel  turned off with no standing charge this term
-- Raises (rolling the opt-in back with it) when a learner turned on can't be
-- charged: no current term, or not billed for it yet.
create or replace function ai_helper_bill_optin(p_optin_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  o        ai_helper_optins;
  t        tenants;
  v_term   terms;
  v_inv    fee_invoices;
  v_link   ai_helper_charges;
  v_charge fee_charges;
  v_name   text;
  v_reason text;
  v_id     uuid;
begin
  select * into o from ai_helper_optins where id = p_optin_id for update;
  if o.id is null then
    raise exception 'That study helper choice could not be found.' using errcode = '22023';
  end if;
  select * into t from tenants where id = o.tenant_id;
  if not t.ai_helper_billing_enabled then return 'billing_off'; end if;
  if t.ai_tutor_access <> 'opt_in' or t.ai_helper_price_cents <= 0 then return 'free'; end if;

  select * into v_term from terms where tenant_id = t.id and is_current;
  select full_name into v_name from students where id = o.student_id;
  if v_term.id is null then
    raise exception 'The school has no current term, so the study helper can''t be added to the fees yet.' using errcode = '22023';
  end if;

  select * into v_link from ai_helper_charges where student_id = o.student_id and term_id = v_term.id for update;
  if v_link.charge_id is not null then
    select * into v_charge from fee_charges where id = v_link.charge_id;
  end if;

  if o.status = 'on' then
    if v_charge.id is not null and v_charge.voided_at is null then return 'already_charged'; end if;
    select * into v_inv from fee_invoices where student_id = o.student_id and term_id = v_term.id for update;
    if v_inv.id is null then
      raise exception '% hasn''t been billed for this term yet, so the study helper can''t be added to the fees. Ask the school office.', v_name
        using errcode = '22023';
    end if;
    v_reason := format('Bloom study helper, Term %s', v_term.index);
    insert into fee_charges (tenant_id, invoice_id, student_id, amount_cents, reason, created_by)
    values (t.id, v_inv.id, o.student_id, t.ai_helper_price_cents, v_reason, auth.uid())
    returning id into v_id;
    insert into ai_helper_charges (tenant_id, student_id, term_id, charge_id)
    values (t.id, o.student_id, v_term.id, v_id)
    on conflict (student_id, term_id) do update set charge_id = excluded.charge_id, created_at = now();
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (t.id, auth.uid(), my_actor_label(), format('Charge added for %s: %s', v_name, v_reason), 'financial',
            jsonb_build_object('charge_id', v_id, 'invoice_id', v_inv.id, 'amount_cents', t.ai_helper_price_cents,
                               'ai_helper_optin_id', o.id));
    return 'charged';
  end if;

  -- turned off
  if v_charge.id is null or v_charge.voided_at is not null then return 'nothing_to_cancel'; end if;
  if now() > v_charge.created_at + make_interval(days => t.ai_helper_cancel_days) then return 'kept'; end if;
  select * into v_inv from fee_invoices where id = v_charge.invoice_id for update;
  -- apply_fee_charge refuses to cancel a charge already paid for; keep it rather than fail the parent's change
  if v_inv.paid_cents > v_inv.total_cents - v_charge.amount_cents then return 'kept'; end if;
  update fee_charges
     set voided_at = now(), voided_by = auth.uid(), void_reason = 'Study helper turned off by a parent or guardian'
   where id = v_charge.id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (t.id, auth.uid(), my_actor_label(),
          format('Charge cancelled for %s: %s (study helper turned off)', v_name, v_charge.reason), 'financial',
          jsonb_build_object('charge_id', v_charge.id, 'invoice_id', v_charge.invoice_id, 'amount_cents', v_charge.amount_cents,
                             'ai_helper_optin_id', o.id));
  return 'cancelled';
end $$;
revoke execute on function ai_helper_bill_optin(uuid) from public, anon, authenticated;
grant execute on function ai_helper_bill_optin(uuid) to service_role;

-- ---------------------------------------------------------------- functions the app calls

-- The office's study helper settings, beside set_ai_settings. Full admins
-- only, like the rest of AI settings. Refuses billing while
-- ai_helper_billing_available() says no (and the constraint would anyway).
create or replace function set_ai_helper_settings(
  p_tenant_id uuid, p_access text, p_price_cents bigint, p_billing_enabled boolean, p_cancel_days int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not may_administer(p_tenant_id) then
    raise exception 'Only the school office can change AI settings.' using errcode = '42501';
  end if;
  if p_access is null or p_access not in ('all', 'opt_in') then
    raise exception 'Choose who may use the study helper.' using errcode = '22023';
  end if;
  if p_price_cents is null or p_price_cents < 0 or p_price_cents > 10000000 then
    raise exception 'Enter a price per term between KES 0 and KES 100,000.' using errcode = '22023';
  end if;
  if p_cancel_days is null or p_cancel_days not between 0 and 60 then
    raise exception 'The cut-off for cancelling must be between 0 and 60 days.' using errcode = '22023';
  end if;
  if coalesce(p_billing_enabled, false) and not ai_helper_billing_available() then
    raise exception 'Charging for the study helper through school fees isn''t available yet.' using errcode = '0A000';
  end if;
  update tenants
     set ai_tutor_access = p_access, ai_helper_price_cents = p_price_cents,
         ai_helper_billing_enabled = coalesce(p_billing_enabled, false), ai_helper_cancel_days = p_cancel_days
   where id = p_tenant_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p_tenant_id, auth.uid(), my_actor_label(),
          format('Study helper for %s%s', case when p_access = 'opt_in' then 'learners whose parent turns it on' else 'every learner' end,
                 case when coalesce(p_billing_enabled, false) then ', billed to fees' else '' end),
          'access', jsonb_build_object('ai_tutor_access', p_access, 'ai_helper_price_cents', p_price_cents,
                                       'ai_helper_billing_enabled', coalesce(p_billing_enabled, false),
                                       'ai_helper_cancel_days', p_cancel_days));
end $$;
revoke execute on function set_ai_helper_settings(uuid, text, bigint, boolean, int) from public, anon;
grant execute on function set_ai_helper_settings(uuid, text, bigint, boolean, int) to authenticated;

-- A parent or guardian turns the study helper on or off for their child.
-- Either guardian may; the row and the log say who. Turning on needs the
-- school to have the helper on and to ask for opt-ins; turning off always
-- works. Calls ai_helper_bill_optin only when the school bills for it.
-- Answers the status, or the billing outcome when billing ran.
create or replace function set_ai_helper_optin(p_student_id uuid, p_on boolean) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_student students;
  t         tenants;
  v_term    uuid;
  v_status  text := case when p_on then 'on' else 'off' end;
  o         ai_helper_optins;
  v_billed  text;
begin
  select * into v_student from students where id = p_student_id;
  if v_student.id is null or v_student.tenant_id is distinct from my_tenant()
     or not exists (select 1 from guardians g where g.student_id = p_student_id and g.profile_id = auth.uid()) then
    raise exception 'That learner could not be found.' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  select * into t from tenants where id = v_student.tenant_id;
  if p_on and (not v_student.active or not t.ai_enabled or not t.ai_tutor_enabled) then
    raise exception 'The school hasn''t turned on the study helper.' using errcode = '22023';
  end if;
  if p_on and t.ai_tutor_access <> 'opt_in' then
    raise exception 'The school has the study helper on for every learner, so there is nothing to turn on.' using errcode = '22023';
  end if;
  select id into v_term from terms where tenant_id = t.id and is_current;

  select * into o from ai_helper_optins where student_id = p_student_id for update;
  -- Already so for this term: nothing to record (and nothing to bill twice).
  if o.id is not null and o.status = v_status and o.term_id is not distinct from v_term then
    return v_status;
  end if;

  insert into ai_helper_optins (tenant_id, student_id, status, term_id, turned_on_by, turned_on_at, changed_by, changed_at)
  values (t.id, p_student_id, v_status, v_term,
          case when p_on then auth.uid() end, case when p_on then now() end, auth.uid(), now())
  on conflict (student_id) do update
     set status = excluded.status, term_id = excluded.term_id, changed_by = excluded.changed_by, changed_at = excluded.changed_at,
         turned_on_by = coalesce(excluded.turned_on_by, ai_helper_optins.turned_on_by),
         turned_on_at = coalesce(excluded.turned_on_at, ai_helper_optins.turned_on_at)
  returning * into o;

  insert into ai_helper_optin_log (tenant_id, student_id, status, term_id, changed_by)
  values (t.id, p_student_id, v_status, v_term, auth.uid());
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (t.id, auth.uid(), my_actor_label(), format('Study helper turned %s for %s', v_status, v_student.full_name), 'access',
          jsonb_build_object('student_id', p_student_id, 'ai_helper_optin_id', o.id, 'status', v_status, 'term_id', v_term));

  if t.ai_helper_billing_enabled then
    v_billed := ai_helper_bill_optin(o.id);
    return v_billed;
  end if;
  return v_status;
end $$;
revoke execute on function set_ai_helper_optin(uuid, boolean) from public, anon;
grant execute on function set_ai_helper_optin(uuid, boolean) to authenticated;

-- One learner's study helper picture: the school's settings, their opt-in
-- (who turned it on, who last changed it), whether they may use it now
-- (exams aside), this month's questions and the term's standing charge.
-- p_student_id null: the caller's own learner record. For the learner,
-- their guardians and the office's fees area; anyone else gets no row.
create or replace function ai_helper_status(p_student_id uuid default null)
returns table (
  student_id uuid, full_name text,
  school_on boolean, access text, billing_enabled boolean, price_cents bigint, cancel_days int,
  status text, active boolean, term_name text,
  turned_on_by_name text, turned_on_at timestamptz, changed_by_name text, changed_at timestamptz,
  questions_this_month int, last_used_at timestamptz, charge_cents bigint
)
language sql stable security definer set search_path = public as $$
  with s as (
    select st.* from students st
     where st.tenant_id = my_tenant()
       and (case when p_student_id is null then st.profile_id = auth.uid() and st.active
                 else st.id = p_student_id end)
       and (st.profile_id = auth.uid()
            or exists (select 1 from guardians g where g.student_id = st.id and g.profile_id = auth.uid())
            or has_perm(st.tenant_id, 'fees'))
     limit 1
  ), cur as (
    select tm.* from terms tm join s on tm.tenant_id = s.tenant_id where tm.is_current
  )
  select s.id, s.full_name,
         t.ai_enabled and t.ai_tutor_enabled, t.ai_tutor_access, t.ai_helper_billing_enabled, t.ai_helper_price_cents, t.ai_helper_cancel_days,
         o.status,
         o.status = 'on' and (not t.ai_helper_billing_enabled or o.term_id = (select id from cur)),
         (select name from terms where id = o.term_id),
         (select full_name from profiles where id = o.turned_on_by), o.turned_on_at,
         (select full_name from profiles where id = o.changed_by), o.changed_at,
         (select count(*)::int from ai_usage u
           where u.task = 'tutor' and u.profile_id = s.profile_id and u.tenant_id = s.tenant_id
             and u.created_at >= date_trunc('month', now())),
         (select max(u.created_at) from ai_usage u
           where u.task = 'tutor' and u.profile_id = s.profile_id and u.tenant_id = s.tenant_id),
         (select c.amount_cents from ai_helper_charges hc join fee_charges c on c.id = hc.charge_id
           where hc.student_id = s.id and hc.term_id = (select id from cur) and c.voided_at is null)
    from s
    join tenants t on t.id = s.tenant_id
    left join ai_helper_optins o on o.student_id = s.id
$$;
revoke execute on function ai_helper_status(uuid) from public, anon;
grant execute on function ai_helper_status(uuid) to authenticated;

-- The office's list: every learner with an opt-in, or who used the study
-- helper this month, with who turned it on and how much they used it. Full
-- admins and the 'fees' area (who would answer a family about the charge).
create or replace function ai_helper_roster(p_tenant_id uuid)
returns table (
  student_id uuid, full_name text, admission_no text, class_name text,
  status text, active boolean, turned_on_by_name text, turned_on_at timestamptz,
  changed_by_name text, changed_at timestamptz,
  questions_this_month int, tokens_this_month bigint, last_used_at timestamptz, charge_cents bigint
)
language sql stable security definer set search_path = public as $$
  with t as (
    select * from tenants where id = p_tenant_id and has_perm(p_tenant_id, 'fees')
  ), cur as (
    select tm.id from terms tm join t on tm.tenant_id = t.id where tm.is_current
  ), used as (
    select u.profile_id, count(*)::int as questions, sum(u.input_tokens + u.output_tokens)::bigint as tokens, max(u.created_at) as last_at
      from ai_usage u join t on u.tenant_id = t.id
     where u.task = 'tutor' and u.created_at >= date_trunc('month', now())
     group by u.profile_id
  )
  select s.id, s.full_name, s.admission_no, c.name,
         o.status,
         coalesce(o.status = 'on' and (not t.ai_helper_billing_enabled or o.term_id = (select id from cur)), false),
         (select full_name from profiles where id = o.turned_on_by), o.turned_on_at,
         (select full_name from profiles where id = o.changed_by), o.changed_at,
         coalesce(used.questions, 0), coalesce(used.tokens, 0), used.last_at,
         (select fc.amount_cents from ai_helper_charges hc join fee_charges fc on fc.id = hc.charge_id
           where hc.student_id = s.id and hc.term_id = (select id from cur) and fc.voided_at is null)
    from t
    join students s on s.tenant_id = t.id and s.active
    left join classes c on c.id = s.class_id
    left join ai_helper_optins o on o.student_id = s.id
    left join used on used.profile_id = s.profile_id
   where o.id is not null or used.profile_id is not null
   order by s.full_name
$$;
revoke execute on function ai_helper_roster(uuid) from public, anon;
grant execute on function ai_helper_roster(uuid) to authenticated;
