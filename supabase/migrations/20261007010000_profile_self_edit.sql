-- What a person may change on their own profiles row, and the two bits of
-- state drivers' self-service needs.
--
-- profile_update_self (20260901000001_rls.sql) is row-level only: it let
-- anyone update ANY column of their own row -- including role and
-- tenant_id, so a parent could make themselves school_admin with one PATCH.
-- RLS can't restrict columns, so a trigger does: when someone who doesn't
-- administer this school edits their own row, only descriptive fields may
-- change. Drivers additionally can't rename themselves -- parents recognise
-- them by the name the school vetted.
--
-- must_change_password: set when an admin hands out a password (drivers,
-- from invite-admin); the person clears it by choosing their own.
-- photo_changed_at: set when a driver changes their own photo, so the admin
-- sees "photo updated" on the Students & staff page and can keep or remove
-- it. Parents use that photo to recognise who's collecting their child, so
-- it goes live immediately but never unseen.

alter table profiles add column must_change_password boolean not null default false;
alter table profiles add column photo_changed_at timestamptz;

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

create trigger profiles_guard_self_edit before update on profiles
  for each row execute function guard_profile_self_edit();

-- Anyone may upload their own photo (path from apps/web/src/lib/uploads.ts:
-- {tenant_id}/avatars/staff-{profile_id}.{ext}). public_assets_write is
-- staff-only, which shut drivers -- and parents -- out of their own photo.
create policy public_assets_own_avatar on storage.objects for all
  using (
    bucket_id = 'public-assets'
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'avatars'
    and storage.filename(name) like 'staff-' || auth.uid()::text || '.%'
  )
  with check (
    bucket_id = 'public-assets'
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'avatars'
    and storage.filename(name) like 'staff-' || auth.uid()::text || '.%'
  );
