-- AI assist: per-school switches, a monthly allowance, and a usage log.
--
-- Every AI request goes through the ai-assist edge function, which holds the
-- Anthropic key, the prompts and the checks; nothing here calls a model.
-- This migration gives that function what it needs to decide:
--
--   tenants.ai_enabled            the school uses AI drafting at all (on by default)
--   tenants.ai_tutor_enabled      learners may use the study helper (off by default:
--                                 the school decides, since its users are children)
--   tenants.ai_monthly_tokens     the school's monthly allowance, input + output tokens;
--                                 Figbloom staff set it (plan), the school can't
--   ai_usage                      one row per request: who, which task, tokens used.
--                                 Never the prompt or the reply.
--   ai_tutor_blocked(profile)     why a learner can't use the study helper right now
--                                 (an exam in progress or open), or null

alter table tenants
  add column ai_enabled boolean not null default true,
  add column ai_tutor_enabled boolean not null default false,
  add column ai_monthly_tokens int not null default 2000000 check (ai_monthly_tokens >= 0);

create table ai_usage (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants on delete cascade,
  profile_id    uuid references profiles on delete set null,
  task          text not null check (task in ('report_comment', 'questions', 'homework', 'message', 'translate', 'tutor')),
  model         text not null,
  input_tokens  int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  -- the request was declined (refusal) or failed; still counted against the allowance
  outcome       text not null default 'ok' check (outcome in ('ok', 'refused', 'error')),
  created_at    timestamptz not null default now()
);
create index on ai_usage (tenant_id, created_at desc);
create index on ai_usage (profile_id, created_at desc);

alter table ai_usage enable row level security;

-- The office sees its school's usage; written only by the edge function (service role).
create policy ai_usage_read on ai_usage for select
  using (is_super() or may_administer(tenant_id));

-- The office turns AI and the study helper on or off for its school.
create or replace function set_ai_settings(p_tenant_id uuid, p_enabled boolean, p_tutor_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not may_administer(p_tenant_id) then
    raise exception 'Only the school office can change AI settings.' using errcode = '42501';
  end if;
  update tenants set ai_enabled = p_enabled, ai_tutor_enabled = p_tutor_enabled where id = p_tenant_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p_tenant_id, auth.uid(), my_actor_label(),
          format('AI assist %s, study helper %s', case when p_enabled then 'on' else 'off' end,
                 case when p_enabled and p_tutor_enabled then 'on' else 'off' end),
          'access', jsonb_build_object('ai_enabled', p_enabled, 'ai_tutor_enabled', p_tutor_enabled));
end $$;
revoke execute on function set_ai_settings(uuid, boolean, boolean) from public, anon;
grant execute on function set_ai_settings(uuid, boolean, boolean) to authenticated;

-- This school's settings and what it has used this calendar month, for the settings screen.
create or replace function ai_status(p_tenant_id uuid)
returns table (ai_enabled boolean, ai_tutor_enabled boolean, monthly_tokens int, used_tokens bigint)
language sql stable security definer set search_path = public as $$
  select t.ai_enabled, t.ai_tutor_enabled, t.ai_monthly_tokens,
         coalesce((select sum(u.input_tokens + u.output_tokens) from ai_usage u
                    where u.tenant_id = t.id and u.created_at >= date_trunc('month', now())), 0)
    from tenants t
   where t.id = p_tenant_id and (t.id = my_tenant() or may_administer(t.id) or is_super())
$$;
revoke execute on function ai_status(uuid) from public, anon;
grant execute on function ai_status(uuid) to authenticated;

-- Why this learner can't use the study helper right now, or null. Blocked
-- while they have an online paper started and not handed in (and its time
-- isn't up), and while a timed exam for their class is open and they haven't
-- handed it in, so the helper can't be asked the questions before they
-- press Start. Assessments left open for days don't block it.
create or replace function ai_tutor_blocked(p_profile_id uuid) returns text
language sql stable security definer set search_path = public as $$
  with me as (
    select s.id, s.class_id from students s where s.profile_id = p_profile_id and s.active
  )
  select case
    when exists (
      select 1 from exam_attempts a
        join exam_papers p on p.id = a.paper_id
        join me on me.id = a.student_id
       where a.submitted_at is null
         and coalesce(exam_attempt_deadline(a.started_at, p.duration_minutes, p.closes_at), a.started_at + interval '12 hours')
             + interval '2 minutes' > now())
      then 'You have a paper in progress. The study helper is off until you hand it in.'
    when exists (
      select 1 from exam_papers p
        join me on me.class_id = p.class_id
       where p.kind = 'exam' and p.mode = 'online' and p.published_at is not null
         and p.closes_at is not null and p.opens_at <= now() and p.closes_at > now()
         and not exists (select 1 from exam_attempts a where a.paper_id = p.id and a.student_id = me.id and a.submitted_at is not null))
      then 'An exam for your class is open. The study helper is off until you have handed it in or it closes.'
  end
$$;
revoke execute on function ai_tutor_blocked(uuid) from public, anon, authenticated;
grant execute on function ai_tutor_blocked(uuid) to service_role;

-- Tokens this school has used since the 1st, for the edge function's allowance check.
create or replace function ai_month_tokens(p_tenant_id uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(input_tokens + output_tokens), 0)
    from ai_usage where tenant_id = p_tenant_id and created_at >= date_trunc('month', now())
$$;
revoke execute on function ai_month_tokens(uuid) from public, anon, authenticated;
grant execute on function ai_month_tokens(uuid) to service_role;
