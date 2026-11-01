-- Other staff, and the visitor log for the ones the office picks.
--
-- 20261027010000 gave the gate and reception an account role each ('guard',
-- 'receptionist'). A school has many more people who aren't teachers --
-- librarians, matrons, nurses, cooks, lab technicians, groundsmen,
-- secretaries -- and a role per job doesn't scale. Now there is one,
-- 'staff' ("Other staff", 20261028100000), and the job is profiles.
-- staff_title (which every profile already has).
--
-- handles_visitors: whether this person keeps the visitor log. Set by the
-- office in People, never by the person themself (guard_profile_self_edit
-- below). With it they get the gate's and reception's work in one screen:
-- record a visitor, move them through arrived -> with host -> left, record a
-- walk-in, escalate to the principal's office. is_front_desk() now means
-- exactly this, so every visits policy and picker from 20261027010001 follows
-- without being rewritten. Hosts, escalation, the trigger and visit-notify's
-- pushes are unchanged.
--
-- What other staff can reach, deliberately narrow:
--   - their own profile, notices addressed to them ("All staff" includes
--     them once the apps send 'staff' in it), items issued to them
--     (inventory_issues_read: profile_id = auth.uid()), and with
--     handles_visitors the visits table and its two pickers.
--   - NOT is_staff(), which stays school_admin or teacher: it opens learners,
--     marks, chats, signatures and rider lists school-wide.
--   - may_contact (calls and chat pairing) is left alone here; other staff
--     reach nobody through it until it's extended on its own.
--
-- Existing accounts: every guard and receptionist becomes 'staff' with the
-- title Guard or Receptionist and handles_visitors on. login_id and the auth
-- email are untouched, so GD-0001 and RC-0001 still sign in as before; new
-- accounts are numbered SF-nnnn (next_login_number counts by role, so the
-- first is one past the highest GD/RC number at that school -- never a
-- collision). Each move is written to the school's audit trail with the
-- title it replaced. Notices already sent to guards or receptionists are
-- re-addressed to 'staff' so the same people still read them.
--
-- 'guard' and 'receptionist' stay in app_role: Postgres can't drop an enum
-- value without rebuilding the type and everything that uses it. A check on
-- profiles and invites stops either being assigned again.

alter table profiles add column handles_visitors boolean not null default false;

-- ---------------------------------------------------------------- existing gate and reception accounts

insert into audit_events (tenant_id, actor_label, event, category, metadata)
select p.tenant_id,
       'Figbloom · system',
       format('%s (%s) moved from %s to Other staff, title %s, with the visitor log',
              p.full_name, coalesce(p.login_id, 'no login ID'),
              case p.role when 'guard' then 'Gate guard' else 'Receptionist' end,
              case p.role when 'guard' then 'Guard' else 'Receptionist' end),
       'provisioning',
       jsonb_build_object('profile_id', p.id, 'previous_role', p.role::text, 'previous_title', p.staff_title)
  from profiles p
 where p.role in ('guard', 'receptionist');

update profiles
   set staff_title = case role when 'guard' then 'Guard' else 'Receptionist' end,
       handles_visitors = true,
       role = 'staff'
 where role in ('guard', 'receptionist');

-- "All guards", or "All staff" as it was sent while the front desk had roles of its own.
update announcements a
   set audience = jsonb_set(a.audience, '{roles}', (
         select coalesce(jsonb_agg(distinct case when x.r in ('guard', 'receptionist') then 'staff' else x.r end), '[]'::jsonb)
           from jsonb_array_elements_text(a.audience->'roles') as x(r)))
 where a.audience->>'kind' = 'roles'
   and jsonb_typeof(a.audience->'roles') = 'array'
   and (a.audience->'roles') ?| array['guard', 'receptionist'];
update announcements
   set audience = jsonb_set(audience, '{role}', '"staff"')
 where audience->>'kind' = 'role' and audience->>'role' in ('guard', 'receptionist');

comment on type app_role is
  'guard and receptionist are retired (20261028100001): those accounts are now staff with a title. '
  'Kept only because an enum value cannot be dropped; profiles_no_retired_roles and invites_no_retired_roles stop them being assigned.';

alter table profiles add constraint profiles_no_retired_roles check (role not in ('guard', 'receptionist'));
alter table invites add constraint invites_no_retired_roles check (role not in ('guard', 'receptionist'));
-- the visitor log is a job other staff are given; admins and teachers reach visits their own way
alter table profiles add constraint profiles_handles_visitors_staff_only check (not handles_visitors or role = 'staff');

-- ---------------------------------------------------------------- the visitor log

create or replace function is_front_desk() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'staff' and handles_visitors from profiles where id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------- self-edit

-- As 20261007010000, plus handles_visitors: only the office hands out the
-- visitor log, so nobody can give it to themselves.
create or replace function guard_profile_self_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- service role (edge functions, seeds) and anyone administering this school
  if auth.uid() is null or may_administer(old.tenant_id) then
    -- an admin setting or removing the photo has seen it
    if new.avatar_url is distinct from old.avatar_url then new.photo_changed_at := null; end if;
    return new;
  end if;

  if new.role is distinct from old.role
    or new.tenant_id is distinct from old.tenant_id
    or new.login_id is distinct from old.login_id
    or new.email is distinct from old.email
    or new.staff_title is distinct from old.staff_title
    or new.handles_visitors is distinct from old.handles_visitors
    or new.created_at is distinct from old.created_at
    or new.photo_changed_at is distinct from old.photo_changed_at
    or (old.role = 'driver' and new.full_name is distinct from old.full_name)
    -- can choose a password (true -> false), never re-arm the prompt
    or (new.must_change_password and not old.must_change_password)
  then
    raise exception 'That change has to be made by the school office.'
      using errcode = '42501';
  end if;

  if old.role = 'driver' and new.avatar_url is distinct from old.avatar_url then
    new.photo_changed_at := case when new.avatar_url is null then null else now() end;
  end if;
  return new;
end $$;
