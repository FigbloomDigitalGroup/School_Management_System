-- Announcements reach only the people they're addressed to.
--
-- Until now the database let anyone in a school read every published
-- announcement (20260916110000 announcement_read): a leave decision sent to
-- one teacher, a cover notice, a message for one class's parents. The apps
-- filtered with audienceIncludes() (packages/shared/src/audience.ts) but a
-- signed-in parent or learner could ask the database for the rest. And any
-- teacher could edit or delete any announcement.
--
-- Now:
--   - audience_reaches(tenant, audience, profile) is the one rule for "is
--     this person in this audience". It mirrors audienceIncludes(): change
--     one, change the other.
--   - read: the office (may_administer), the author, and, once published,
--     the people the audience reaches. Teachers no longer see other
--     teachers' class messages or messages addressed to someone else.
--   - write: the office, any audience; a teacher only their own, and only
--     to a class they teach or are class teacher of, or to named people.
--   - announcement_recipients(id) gives send-push the same list, so a
--     "students only" class message no longer buzzes parents' phones.
--   - may_read_announcement (attachments, 20261026020000) follows the new
--     read rule, so a file on a message is no more public than the message.
--
-- Audience shapes (packages/shared/src/types.ts Audience):
--   whole_school | role{role} | roles{roles[]} | user{user_id} |
--   people{profile_ids[]} | class{class_id, recipients?} |
--   form_level{form_level, level?, recipients?}
-- recipients: guardians | students | both (omitted = both). Class and year
-- notices reach a class's parents and learners, never the staff teaching it.

create or replace function audience_reaches(p_tenant uuid, p_audience jsonb, p_profile uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text;
  v_kind text := p_audience->>'kind';
  v_side text;
  v_recipients text := coalesce(p_audience->>'recipients', 'both');
begin
  if p_audience is null or p_profile is null then return false; end if;
  select role::text into v_role from profiles where id = p_profile and tenant_id = p_tenant;
  if v_role is null then return false; end if;

  if v_kind = 'whole_school' then return true; end if;
  if v_kind = 'role' then return p_audience->>'role' = v_role; end if;
  if v_kind = 'roles' then return jsonb_typeof(p_audience->'roles') = 'array' and (p_audience->'roles') ? v_role; end if;
  if v_kind = 'user' then return p_audience->>'user_id' = p_profile::text; end if;
  if v_kind = 'people' then return jsonb_typeof(p_audience->'profile_ids') = 'array' and (p_audience->'profile_ids') ? p_profile::text; end if;
  if v_kind not in ('class', 'form_level') then return false; end if; -- a kind this rule doesn't know: never guess

  -- Which side of a class this person reads from, by role alone (a teacher
  -- who is also someone's guardian still gets a teacher's inbox).
  v_side := case v_role when 'parent' then 'guardians' when 'student' then 'students' end;
  if v_side is null or (v_recipients <> 'both' and v_recipients <> v_side) then return false; end if;

  return exists (
    select 1
      from students s
      join classes c on c.id = s.class_id
     where s.tenant_id = p_tenant
       and s.active
       and (case when v_side = 'students' then s.profile_id = p_profile
                 else exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = p_profile) end)
       and (case when v_kind = 'class' then c.id::text = p_audience->>'class_id'
                 else c.form_level::text = p_audience->>'form_level'
                      and (p_audience->>'level' is null or c.level::text = p_audience->>'level') end)
  );
end $$;

-- Only for the caller themself; checking someone else would let anyone map
-- who is in which class.
revoke execute on function audience_reaches(uuid, jsonb, uuid) from public, anon, authenticated;

create or replace function announcement_visible_to_me(p_tenant uuid, p_audience jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select p_tenant = my_tenant() and audience_reaches(p_tenant, p_audience, auth.uid())
$$;
revoke execute on function announcement_visible_to_me(uuid, jsonb) from public, anon;
grant execute on function announcement_visible_to_me(uuid, jsonb) to authenticated;

-- What a teacher may address: a class they teach or are class teacher of, or named people.
create or replace function teacher_may_address(p_tenant uuid, p_audience jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_audience->>'kind'
    when 'user' then true
    when 'people' then true
    when 'class' then exists (
      select 1 from classes c
       where c.tenant_id = p_tenant and c.id::text = p_audience->>'class_id'
         and (c.class_teacher_id = auth.uid()
              or exists (select 1 from teaching_assignments ta where ta.class_id = c.id and ta.teacher_id = auth.uid())))
    else false
  end
$$;
revoke execute on function teacher_may_address(uuid, jsonb) from public, anon;
grant execute on function teacher_may_address(uuid, jsonb) to authenticated;

-- Everyone an announcement reaches, for send-push (service role only).
create or replace function announcement_recipients(p_announcement_id uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select p.id
    from announcements a
    join profiles p on p.tenant_id = a.tenant_id
   where a.id = p_announcement_id
     and audience_reaches(a.tenant_id, a.audience, p.id)
$$;
revoke execute on function announcement_recipients(uuid) from public, anon, authenticated;
grant execute on function announcement_recipients(uuid) to service_role;

-- ---------------------------------------------------------------- policies
drop policy announcement_read on announcements;
create policy announcement_read on announcements for select
  using (
    is_super()
    or may_administer(tenant_id)
    or author_id = auth.uid()
    or (published_at is not null and announcement_visible_to_me(tenant_id, audience))
  );

drop policy announcement_write on announcements;
create policy announcement_insert on announcements for insert
  with check (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and author_id = auth.uid() and teacher_may_address(tenant_id, audience))
  );
create policy announcement_update on announcements for update
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and my_role() = 'teacher' and author_id = auth.uid()))
  with check (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and author_id = auth.uid() and teacher_may_address(tenant_id, audience))
  );
create policy announcement_delete on announcements for delete
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and my_role() = 'teacher' and author_id = auth.uid()));

-- Attachments follow the message.
create or replace function may_read_announcement(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from announcements a
     where a.id = p_id
       and (
         is_super()
         or may_administer(a.tenant_id)
         or a.author_id = auth.uid()
         or (a.published_at is not null and announcement_visible_to_me(a.tenant_id, a.audience))
       )
  )
$$;
