-- FIG-391 (20260916110000_org_admin_full_school_access.sql) widened most of
-- the app for an org_admin acting inside a member school, but missed a
-- second batch entirely: leave requests and coverage, timetable and
-- teacher_subjects, student documents, payment proofs/insert, higher-ed
-- (courses/sections/assessments/marks/grades/enrollments/semesters), and
-- fleet (vehicles/routes/trips/alerts/locations/assignments/transport).
-- Confirmed live: an org_admin acting inside a member school could not see
-- its leave requests, upload its crest, or read most of its higher-ed/fleet
-- data at all -- every one of these still gated purely on
-- `tenant_id = my_tenant()` / `my_role() = 'school_admin'`, both of which
-- are never true for an org_admin (their own tenant_id is always null).
--
-- Every change below is purely additive, exactly like FIG-391: an existing
-- clause is never removed or narrowed, only OR'd with may_administer(tenant_id).

-- leave requests + coverage (the "leave requests"/"leaves taken" gap)
drop policy leave_read on leave_requests;
create policy leave_read on leave_requests for select
  using (is_super() or may_administer(tenant_id) or (tenant_id = my_tenant() and (my_role() = 'school_admin' or teacher_id = auth.uid())));
drop policy leave_update on leave_requests;
create policy leave_update on leave_requests for update
  using (
    is_super() or may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and teacher_id = auth.uid() and status = 'pending')
  )
  with check (
    is_super() or may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and teacher_id = auth.uid())
  );

drop policy coverage_read on coverage_assignments;
create policy coverage_read on coverage_assignments for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy coverage_write on coverage_assignments;
create policy coverage_write on coverage_assignments for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

-- schedules and specializations
drop policy timetable_read on timetable_slots;
create policy timetable_read on timetable_slots for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy timetable_write on timetable_slots;
create policy timetable_write on timetable_slots for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy teacher_subjects_read on teacher_subjects;
create policy teacher_subjects_read on teacher_subjects for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy teacher_subjects_write on teacher_subjects;
create policy teacher_subjects_write on teacher_subjects for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

-- student records (birth certificates, medical forms, etc.)
drop policy student_documents_read on student_documents;
create policy student_documents_read on student_documents for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy student_documents_write on student_documents;
create policy student_documents_write on student_documents for all
  using (is_super() or (tenant_id = my_tenant() and is_staff()) or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and is_staff()) or may_administer(tenant_id));

-- payment proofs: read/staff-manage widened; the two self-service insert
-- policies (guardian/student uploading their own proof) are untouched --
-- an org_admin never uploads a proof on someone else's behalf.
drop policy payment_proofs_read on payment_proofs;
create policy payment_proofs_read on payment_proofs for select
  using (
    is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id)
    or exists (select 1 from fee_invoices i join guardians g on g.student_id = i.student_id where i.id = payment_proofs.invoice_id and g.profile_id = auth.uid())
    or exists (select 1 from fee_invoices i join students s on s.id = i.student_id where i.id = payment_proofs.invoice_id and s.profile_id = auth.uid())
  );
drop policy payment_proofs_staff_manage on payment_proofs;
create policy payment_proofs_staff_manage on payment_proofs for all
  using (is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id))
  with check (is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id));

-- higher education
drop policy courses_read on courses;
create policy courses_read on courses for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy courses_write on courses;
create policy courses_write on courses for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy semesters_read on semesters;
create policy semesters_read on semesters for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy semesters_write on semesters;
create policy semesters_write on semesters for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy course_section_read on course_sections;
create policy course_section_read on course_sections for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy course_section_write on course_sections;
create policy course_section_write on course_sections for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy course_section_timetable_read on course_section_timetable_slots;
create policy course_section_timetable_read on course_section_timetable_slots for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy course_section_timetable_write on course_section_timetable_slots;
create policy course_section_timetable_write on course_section_timetable_slots for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy enrollment_write on enrollments;
create policy enrollment_write on enrollments for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy course_assessment_read on course_assessments;
create policy course_assessment_read on course_assessments for select
  using (is_super() or ((tenant_id = my_tenant()) and (is_staff() or published_at is not null)) or may_administer(tenant_id));
drop policy course_assessment_write on course_assessments;
create policy course_assessment_write on course_assessments for all
  using (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher') and teaches_section(course_section_id))
  )
  with check (is_super() or may_administer(tenant_id) or tenant_id = my_tenant());

drop policy course_mark_read on course_marks;
create policy course_mark_read on course_marks for select
  using (
    is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id)
    or ((student_id in (select s.id from students s where s.profile_id = auth.uid()))
        and exists (select 1 from course_assessments a where a.id = course_marks.assessment_id and a.published_at is not null))
  );
drop policy course_mark_write on course_marks;
create policy course_mark_write on course_marks for all
  using (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher')
        and exists (select 1 from course_assessments a where a.id = course_marks.assessment_id and teaches_section(a.course_section_id)))
  )
  with check (is_super() or may_administer(tenant_id) or tenant_id = my_tenant());

drop policy course_grade_read on course_grades;
create policy course_grade_read on course_grades for select
  using (
    is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id)
    or (student_id in (select s.id from students s where s.profile_id = auth.uid()))
  );
drop policy course_grade_write on course_grades;
create policy course_grade_write on course_grades for all
  using (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher') and teaches_section(course_section_id))
  )
  with check (is_super() or may_administer(tenant_id) or tenant_id = my_tenant());

-- fleet (transport) -- driver-only and family-visibility branches untouched
drop policy vehicles_read on vehicles;
create policy vehicles_read on vehicles for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy vehicles_write on vehicles;
create policy vehicles_write on vehicles for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy routes_read on routes;
create policy routes_read on routes for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy routes_write on routes;
create policy routes_write on routes for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy route_stops_read on route_stops;
create policy route_stops_read on route_stops for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy route_stops_write on route_stops;
create policy route_stops_write on route_stops for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy vehicle_assignments_read on vehicle_assignments;
create policy vehicle_assignments_read on vehicle_assignments for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy vehicle_assignments_write on vehicle_assignments;
create policy vehicle_assignments_write on vehicle_assignments for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy student_transport_read on student_transport;
create policy student_transport_read on student_transport for select
  using (is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id) or (student_id in (select my_students())));
drop policy student_transport_write on student_transport;
create policy student_transport_write on student_transport for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy trips_read on trips;
create policy trips_read on trips for select
  using (is_super() or ((tenant_id = my_tenant()) and (is_staff() or driver_id = auth.uid())) or may_administer(tenant_id));
drop policy trips_staff_write on trips;
create policy trips_staff_write on trips for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin') or may_administer(tenant_id));

drop policy vehicle_alerts_read on vehicle_alerts;
create policy vehicle_alerts_read on vehicle_alerts for select
  using (is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id));
drop policy vehicle_alerts_ack on vehicle_alerts;
create policy vehicle_alerts_ack on vehicle_alerts for update
  using (is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id))
  with check (is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id));

drop policy vehicle_locations_read_staff on vehicle_locations;
create policy vehicle_locations_read_staff on vehicle_locations for select
  using (is_super() or ((tenant_id = my_tenant()) and is_staff()) or may_administer(tenant_id));

-- storage: crest/avatar uploads and student-record documents, staff-gated
-- the same "tenant_id = my_tenant()" way -- widened so an org_admin acting
-- inside a member school can upload/replace either.
drop policy public_assets_write on storage.objects;
create policy public_assets_write on storage.objects for all
  using (bucket_id = 'public-assets' and (is_super() or (is_staff() and (storage.foldername(name))[1] = my_tenant()::text) or may_administer((storage.foldername(name))[1]::uuid)))
  with check (bucket_id = 'public-assets' and (is_super() or (is_staff() and (storage.foldername(name))[1] = my_tenant()::text) or may_administer((storage.foldername(name))[1]::uuid)));

drop policy private_docs_staff_write on storage.objects;
create policy private_docs_staff_write on storage.objects for all
  using (bucket_id = 'private-documents' and (is_super() or (is_staff() and (storage.foldername(name))[1] = my_tenant()::text) or may_administer((storage.foldername(name))[1]::uuid)))
  with check (bucket_id = 'private-documents' and (is_super() or (is_staff() and (storage.foldername(name))[1] = my_tenant()::text) or may_administer((storage.foldername(name))[1]::uuid)));

drop policy private_docs_read on storage.objects;
create policy private_docs_read on storage.objects for select
  using (bucket_id = 'private-documents' and (is_super() or (storage.foldername(name))[1] = my_tenant()::text or may_administer((storage.foldername(name))[1]::uuid)));

-- the three school-settings RPCs: each only ever checked
-- `my_role() = 'school_admin'` and updated `where id = my_tenant()`, both
-- of which are never true for an org_admin (their own tenant_id is always
-- null) -- so acting inside a member school via "Open school console"
-- could never actually save these. Take an explicit tenant id and check
-- may_administer(p_tenant_id) instead.
drop function set_school_payment_methods(text, text, text, text);
create function set_school_payment_methods(
  p_tenant_id uuid, p_paybill text, p_till text, p_bank_details text, p_notes text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not may_administer(p_tenant_id) then
    raise exception 'you do not administer this school';
  end if;

  update tenants set
    payment_paybill      = nullif(trim(p_paybill), ''),
    payment_till         = nullif(trim(p_till), ''),
    payment_bank_details = nullif(trim(p_bank_details), ''),
    payment_notes        = nullif(trim(p_notes), '')
  where id = p_tenant_id;
end;
$$;
revoke all on function set_school_payment_methods(uuid, text, text, text, text) from public;
grant execute on function set_school_payment_methods(uuid, text, text, text, text) to authenticated;

drop function set_school_logo(text);
create function set_school_logo(p_tenant_id uuid, p_logo_url text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not may_administer(p_tenant_id) then
    raise exception 'you do not administer this school';
  end if;

  update tenants set logo_url = nullif(trim(p_logo_url), '') where id = p_tenant_id;
end;
$$;
revoke all on function set_school_logo(uuid, text) from public;
grant execute on function set_school_logo(uuid, text) to authenticated;

drop function set_school_details(text, text, text);
create function set_school_details(
  p_tenant_id uuid, p_name text, p_county text, p_moe_registration text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not may_administer(p_tenant_id) then
    raise exception 'you do not administer this school';
  end if;
  if trim(coalesce(p_name, '')) = '' then
    raise exception 'the school needs a name';
  end if;

  update tenants set
    name              = trim(p_name),
    county            = trim(p_county),
    moe_registration  = nullif(trim(p_moe_registration), '')
  where id = p_tenant_id;
end;
$$;
revoke all on function set_school_details(uuid, text, text, text) from public;
grant execute on function set_school_details(uuid, text, text, text) to authenticated;
