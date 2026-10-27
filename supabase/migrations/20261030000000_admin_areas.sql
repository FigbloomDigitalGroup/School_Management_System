-- Admin access by area: a deputy, a bursar or a secretary gets the part of
-- the admin console their job needs, not all of it.
--
-- Until now school_admin was one all-powerful role: may_administer(tenant)
-- (that school's school_admin, an org_admin of its organization, or a
-- super_admin) gated nearly every write and many reads. A school's head
-- teacher, deputies, bursar and secretary all needed it to do their work,
-- so all of them saw and could change everything: fees, marks, staff
-- accounts, settings. Schools asked for the top admins to keep the full
-- overview and everyone else to get only what their job needs, with one
-- person able to hold several jobs.
--
-- Decision: permission areas, granted to teachers and other staff.
--
--   area           what it allows
--   people         learner, staff and parent records, admissions, bio data
--                  approvals, learner documents, accounts and passwords
--   fees           invoices, payments, proofs, charges, M-Pesa, receipts and
--                  invoice signatures
--   academics      classes, subjects, timetable, exams, marks and their
--                  publication, report cards, analytics, homework, learning
--                  materials, online and live classes, CBE, courses
--   attendance     correcting any class's register
--   transport      fleet, routes, stops, trips, riders, bus alerts
--   communication  announcements, chat oversight, call logs
--   inventory      stock and issued items
--   activities     sports, clubs and their events
--   visitors       the visitor log (what handles_visitors gave before)
--   medical        reserved for the medical module (next PR). It gates
--                  nothing yet except reading learners' health records.
--   leave          staff leave requests
--
-- Everything else is full-admin only and stays on may_administer: school
-- settings and branding, terms and semesters, AI settings, payment methods,
-- the dashboard overview and reports, the audit trail, impersonation and
-- organization logs, and managing these permissions themselves.
--
-- Who has what:
--   * full admins: the school_admin role, org admins of the school's
--     organization, super admins. may_administer() is unchanged, and
--     has_perm() starts with it, so every existing admin keeps everything.
--   * a teacher or other staff member ('staff', 20261028100000) holds the
--     areas in staff_permissions. A teacher who is also the deputy keeps
--     one login and the teacher console, and gains the admin console for
--     their areas. Other roles (parents, learners, drivers) never hold any:
--     the grant RPC refuses them and has_perm() ignores a grant whose holder
--     has since become something else.
--   * grants are written only by full admins, through set_staff_areas(),
--     which validates the areas and that the person is a teacher or staff
--     at the same school, refuses anyone granting themselves anything, and
--     writes each change to the school's audit trail. The table has no
--     write policies, so the API can't do it any other way.
--
-- Presets (Deputy principal, Bursar, Secretary, ...) are named bundles of
-- areas in packages/shared/src/adminAreas.ts. A person can hold several;
-- their areas are the union. The database only ever sees areas, so a
-- preset can change without a migration.
--
-- has_office_perm() answers "holds some admin area other than the visitor
-- log alone": the screens of every area list learners and staff (a bursar
-- invoices learners, a storekeeper issues to them), so it opens the learner,
-- profile and guardian lists the way is_staff() does for teachers. The
-- visitor log keeps its own narrow pickers (visit_hosts,
-- visit_find_learners) and doesn't open the roster. is_staff() is not
-- widened: it also opens marks, chats, signatures and rider lists.
--
-- handles_visitors (20261028100001) becomes a 'visitors' grant for every
-- profile that has it, and is_front_desk() now answers from the grants.
-- The column stays, unread, until every client that writes it is gone (an
-- invite-admin still deployed from before this sets it on new staff); see
-- the comment on it below.
--
-- 20261030000001 moves each area's policies and functions from
-- may_administer to has_perm, with the full mapping in its header.

-- ---------------------------------------------------------------- areas
create or replace function is_admin_area(p_area text) returns boolean
language sql immutable as $$
  select p_area in ('people', 'fees', 'academics', 'attendance', 'transport', 'communication',
                    'inventory', 'activities', 'visitors', 'medical', 'leave')
$$;

create table staff_permissions (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  area       text not null constraint staff_permissions_area_known check (is_admin_area(area)),
  granted_by uuid references profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (profile_id, area)
);
create index on staff_permissions (tenant_id);

alter table staff_permissions enable row level security;
-- your own areas (the consoles read them), and every grant at a school you fully administer
create policy staff_permissions_read on staff_permissions for select
  using (profile_id = auth.uid() or may_administer(tenant_id));
-- no insert/update/delete policy: set_staff_areas() is the only way in

-- ---------------------------------------------------------------- the checks
-- A full admin, or a teacher or other staff member at this school holding the
-- area. my_tenant() is a no-match id for a suspended school, so a suspended
-- school's grants answer false along with everything else. A null area (no
-- area covers it) is full admins only.
create or replace function has_perm(p_tenant uuid, p_area text) returns boolean
language sql stable security definer set search_path = public as $$
  select may_administer(p_tenant)
      or exists (
        select 1
          from staff_permissions sp
          join profiles p on p.id = sp.profile_id
         where sp.profile_id = auth.uid()
           and sp.tenant_id = p_tenant
           and p_tenant = my_tenant()
           and sp.area = p_area
           and p.role in ('teacher', 'staff'))
$$;

-- A full admin, or anyone holding an area other than the visitor log: what
-- opens the school's learner, staff and parent lists (see the header).
create or replace function has_office_perm(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select may_administer(p_tenant)
      or exists (
        select 1
          from staff_permissions sp
          join profiles p on p.id = sp.profile_id
         where sp.profile_id = auth.uid()
           and sp.tenant_id = p_tenant
           and p_tenant = my_tenant()
           and sp.area <> 'visitors'
           and p.role in ('teacher', 'staff'))
$$;

-- Which area a signed document belongs to (signature_requests/signatures.doc_kind).
create or replace function signed_doc_area(p_kind text) returns text
language sql immutable as $$
  select case p_kind
    when 'student_document' then 'people'
    when 'report_card' then 'academics'
    when 'fee_invoice' then 'fees'
    when 'payment_receipt' then 'fees'
    when 'attachment' then 'communication'
  end
$$;

-- Which area a private-documents folder belongs to (<tenant>/<folder>/...,
-- lib/uploads.ts). A folder not listed is full admins only.
create or replace function private_doc_area(p_folder text) returns text
language sql immutable as $$
  select case p_folder
    when 'students' then 'people'
    when 'invoices' then 'fees'
    when 'submissions' then 'academics'
    when 'exam-papers' then 'academics'
    when 'paper-imports' then 'academics'
  end
$$;

-- ---------------------------------------------------------------- granting
-- Replaces a teacher's or other staff member's areas with p_areas (an empty
-- array removes them all) and returns what they hold now. Full admins only,
-- never for yourself; one audit event per call says what was given and
-- what was taken away.
create or replace function set_staff_areas(p_profile_id uuid, p_areas text[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_target  profiles%rowtype;
  v_areas   text[] := coalesce((select array_agg(distinct a order by a) from unnest(p_areas) a where a is not null), '{}');
  v_granted text[];
  v_revoked text[];
begin
  select * into v_target from profiles where id = p_profile_id;
  if v_target.id is null or v_target.tenant_id is null or not may_administer(v_target.tenant_id) then
    raise exception 'Only a full admin of this school can change admin access.' using errcode = '42501';
  end if;
  if v_target.id = auth.uid() then
    raise exception 'You can''t change your own admin access.' using errcode = '42501';
  end if;
  if v_target.role not in ('teacher', 'staff') then
    raise exception 'Admin areas are for teachers and other staff. A principal or director should be a full admin instead.'
      using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_areas) a where not is_admin_area(a)) then
    raise exception 'Unknown admin area: %', (select string_agg(a, ', ') from unnest(v_areas) a where not is_admin_area(a))
      using errcode = '22023';
  end if;

  with gone as (
    delete from staff_permissions
     where profile_id = v_target.id and not (area = any (v_areas))
    returning area
  )
  select coalesce(array_agg(area order by area), '{}') into v_revoked from gone;

  with added as (
    insert into staff_permissions (tenant_id, profile_id, area, granted_by)
    select v_target.tenant_id, v_target.id, a, auth.uid() from unnest(v_areas) a
    on conflict (profile_id, area) do nothing
    returning area
  )
  select coalesce(array_agg(area order by area), '{}') into v_granted from added;

  if cardinality(v_granted) > 0 or cardinality(v_revoked) > 0 then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (v_target.tenant_id, auth.uid(), my_actor_label(),
            format('Admin access for %s: %s', v_target.full_name,
                   concat_ws('; ',
                     case when cardinality(v_granted) > 0 then 'given ' || array_to_string(v_granted, ', ') end,
                     case when cardinality(v_revoked) > 0 then 'removed ' || array_to_string(v_revoked, ', ') end)),
            'access',
            jsonb_build_object('profile_id', v_target.id, 'granted', to_jsonb(v_granted), 'revoked', to_jsonb(v_revoked),
                               'areas', to_jsonb(v_areas)));
  end if;
  return v_areas;
end $$;

revoke execute on function set_staff_areas(uuid, text[]) from public, anon;
grant execute on function set_staff_areas(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------- the visitor log
-- Everyone the office gave the visitor log keeps it, now as a grant.
insert into audit_events (tenant_id, actor_label, event, category, metadata)
select p.tenant_id,
       'Figbloom · system',
       format('%s (%s) keeps the visitor log, now as the Visitors admin area', p.full_name, coalesce(p.login_id, 'no login ID')),
       'access',
       jsonb_build_object('profile_id', p.id, 'granted', jsonb_build_array('visitors'), 'from', 'handles_visitors')
  from profiles p
 where p.handles_visitors and p.tenant_id is not null
   and not exists (select 1 from staff_permissions sp where sp.profile_id = p.id and sp.area = 'visitors');

insert into staff_permissions (tenant_id, profile_id, area)
select tenant_id, id, 'visitors' from profiles
 where handles_visitors and tenant_id is not null
on conflict (profile_id, area) do nothing;

-- Holds the visitor log at their own school. Kept (rather than dropped)
-- because 20261027010001's policies and pickers were written against it;
-- 20261030000001 moves those to has_perm(..., 'visitors') directly.
create or replace function is_front_desk() returns boolean
language sql stable security definer set search_path = public as $$
  select has_perm(my_tenant(), 'visitors')
$$;

comment on column profiles.handles_visitors is
  'Deprecated (20261030000000): the visitor log is the visitors area in staff_permissions. '
  'Nothing reads this any more; it is kept only so an invite-admin deployed before that migration can still insert staff. '
  'Drop it once every deployed function is past 20261030000000.';
