-- FIG-1461: who may replace or delete the school's logo and learners' photos.
--
-- public_assets_write let anyone for whom is_staff() is true (school admins AND teachers) write or delete ANY object under their school's
-- folder in public-assets. So a teacher could overwrite {school}/branding/logo.png (changing the crest on every screen and report, with
-- nothing in the database to show it) or swap a learner's photo ({school}/avatars/students-{learner}.png). Storage writes leave no audit
-- entry. The school's ruling:
--
--   * the school logo and anything else outside avatars/ (branding/): the school admin (and Figbloom staff);
--   * a learner's photo (avatars/students-{learner id}.*): the school admin, staff holding the people area, and that learner's class
--     teacher (a teacher cannot set the photo of a learner in another class);
--   * a person's own photo (avatars/staff-{their id}.*): themselves (public_assets_own_avatar, unchanged);
--   * reading stays public to the school (public_assets_read, unchanged).
--
-- supabase/rls-checks/ and tests/integration/uploads.test.ts check it.

drop policy public_assets_write on storage.objects;

create policy public_assets_write on storage.objects for all
using (
  bucket_id = 'public-assets'
  and (
    is_super()
    or may_administer(((storage.foldername(name))[1])::uuid)
    or (has_perm(((storage.foldername(name))[1])::uuid, 'people') and (storage.foldername(name))[2] = 'avatars')
    or (
      (storage.foldername(name))[1] = my_tenant()::text
      and (storage.foldername(name))[2] = 'avatars'
      and my_role() = 'teacher'
      and exists (
        -- objects.name, not name: classes has a name column too
        select 1 from students s join classes c on c.id = s.class_id
         where c.class_teacher_id = auth.uid()
           and s.id::text = substring(storage.filename(objects.name) from '^students-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})([.-]|$)')
      )
    )
  )
)
with check (
  bucket_id = 'public-assets'
  and (
    is_super()
    or may_administer(((storage.foldername(name))[1])::uuid)
    or (has_perm(((storage.foldername(name))[1])::uuid, 'people') and (storage.foldername(name))[2] = 'avatars')
    or (
      (storage.foldername(name))[1] = my_tenant()::text
      and (storage.foldername(name))[2] = 'avatars'
      and my_role() = 'teacher'
      and exists (
        select 1 from students s join classes c on c.id = s.class_id
         where c.class_teacher_id = auth.uid()
           and s.id::text = substring(storage.filename(objects.name) from '^students-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})([.-]|$)')
      )
    )
  )
);
