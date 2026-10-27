-- Each admin area's policies and functions move from may_administer to
-- has_perm(tenant, '<area>') (20261030000000).
--
-- has_perm() is may_administer() OR a grant, so nothing a full admin (the
-- school_admin role, an org admin, a super admin) could do changes; a
-- teacher or other staff member gains exactly what their areas cover.
-- Teachers without areas are unchanged: every teacher branch (is_staff(),
-- my_role() = 'teacher', may_teach_class_subject's teaching check) is kept
-- as it was.
--
-- Every policy and function below is recreated from its latest definition
-- (read from a database with every earlier migration applied, not from the
-- file that first created it, since later migrations redefined many), with
-- only may_administer(x) changed to has_perm(x, '<area>') unless the
-- "by hand" notes say otherwise. Policies are changed with ALTER POLICY,
-- which fails loudly if a policy isn't there under that name, and keeps
-- its command and roles.
--
-- ---------------------------------------------------------------- screens
--   admin screen (apps/web/src/screens/admin)        area
--   Dashboard (the overview)                         full admin (others get a home listing their areas)
--   People, PromoteClass (moves learners: + people)  people
--   Fees, FeeCollection, FeeItemsEditor              fees
--   Classes, Subjects, SubjectsEditor, Courses,      academics
--     TimetableEditor, Exams, papers, materials,
--     ReportCards, CbeReport, Performance, CoverageCard
--   AttendanceDetail (on the limited admin's home)   attendance
--   Fleet, TripHistory                               transport
--   Announcements, Chats                             communication
--   Inventory                                        inventory
--   Activities                                       activities
--   Visitors                                         visitors
--   Leave                                            leave
--   TermSetup (school settings), Reports, Bloom,     full admin
--     the audit trail, permissions themselves
--   Account                                          everyone in the console (their own account)
--
-- ---------------------------------------------------------------- policies
--   people         students (student_write); guardians (guardian_write);
--                  student_documents (student_documents_office_write,
--                  student_documents_read); student_bio_requests
--                  (student_bio_requests_read); student_health
--                  (student_health_admin_write); password_reset_requests
--                  (password_reset_requests_admin_read)
--   fees           fee_invoices (invoice_read, invoice_write); fee_items
--                  (fee_item_read, fee_item_write); payment_proofs
--                  (payment_proofs_office_manage, payment_proofs_read);
--                  payments (payment_read)
--   academics      assignments (4); cbe_assessments, cbe_results,
--                  cbe_assessment_comments (read); class_meeting_links (2);
--                  classes (2); courses, course_sections,
--                  course_section_timetable_slots, course_assessments,
--                  course_marks, course_grades (2 each); coverage_assignments
--                  (2); enrollments (enrollment_write); exam_attempts,
--                  exam_papers (read); exams (2); learner_competencies,
--                  learning_materials, live_classes, mark_publications
--                  (read); marks (2); online_lessons (2); remote_days (2);
--                  report_cards (2); strands (strand_read,
--                  strand_write_school); subjects (2); teacher_subjects (2);
--                  teaching_assignments (2); timetable_slots (2)
--   attendance     attendance (attendance_write)
--   transport      routes, route_stops, vehicles, vehicle_assignments,
--                  trips, trip_riders, student_transport (read + write
--                  each); vehicle_alerts (read, ack); vehicle_locations
--                  (vehicle_locations_read_staff)
--   communication  announcements (announcement_read, announcement_update,
--                  announcement_delete); calls (calls_read)
--   inventory      inventory_items (read, write); inventory_issues (insert,
--                  read, update)
--   activities     activities (read, insert, delete); activity_patrons
--                  (read, write); activity_events, activity_members,
--                  activity_event_participants (read)
--   leave          leave_requests (leave_read, leave_update)
--   full admin     terms, semesters (read + write); audit_events
--   (unchanged)    (audit_read); impersonation_sessions; ai_usage; invites
--                  (unused by the apps); visits (visits_delete: the log is
--                  kept, only a full admin removes an entry);
--                  organization_access_log (school_admin role, not
--                  may_administer)
--   by hand        profiles.profile_admin_manage: people, but never a full
--                  admin's profile, never your own, never making anyone one.
--                  announcements.announcement_insert: communication, plus a
--                  direct note to one person from anyone holding an area
--                  (a leave decision, an attendance reminder).
--                  guardians.guardian_read: any area but visitors
--                  (has_office_perm), like students and profiles below.
--                  student_health.student_health_read: people or medical.
--                  visits (insert, read, update): visitors, replacing
--                  is_front_desk().
--                  signature_requests/signatures (read): the area of the
--                  document signed (signed_doc_area).
--                  storage private-documents (office write, read): the area
--                  of the folder (private_doc_area); public-assets write:
--                  people for photos (avatars/), full admin for branding.
--   widened reads  students.student_read, profiles.profile_read_self: any
--   (no            area but visitors (has_office_perm), so other staff with
--   may_administer an area see the learner and staff lists teachers already
--   before)        see. attendance.attendance_read: attendance.
--
-- ---------------------------------------------------------------- functions
--   people         archive_learners, restore_learners, decide_bio_request,
--                  set_child_bio, set_child_home, request_signatures
--   fees           record_payment, charge_learner, void_fee_charge,
--                  payment_proofs_check_sms
--   academics      may_teach_class_subject, may_assess,
--                  may_rate_competencies, may_mark_submission,
--                  may_read_assignment, may_change_assignment,
--                  exam_paper_open_to_me, may_read_exam_questions,
--                  material_open_to_me, learning_media_admin,
--                  live_class_role, may_host_class,
--                  set_report_card_teacher_comment, class_exam_performance,
--                  class_learner_exam_means, learner_results_history
--   transport      assign_learner_bus, save_route_stops, trip_rider_list,
--                  guard_vehicle_driver_columns
--   communication  may_read_announcement, may_change_announcement,
--                  may_read_conversation, school_conversations
--   inventory      issue_item_to_class
--   activities     may_manage_activity, activities_consistent
--   leave          guard_leave_review
--   visitors       visit_hosts, visit_find_learners (is_front_desk() is in
--                  20261030000000)
--   full admin     set_school_details, set_school_accent, set_school_logo,
--   (unchanged)    set_school_payment_methods, set_ai_settings
--   unchanged      ai_status, activity_patron_names: anyone at the school
--                  already passes; may_administer there is only the org
--                  admin's way in
--   by hand        may_read_signed_document: student_document people,
--                  report_card academics, fee_invoice and payment_receipt
--                  fees. may_sign_unasked: signing a report card as
--                  principal stays full admin; as bursar fees; a learner
--                  document people. signature_status, void_signature: the
--                  document's area. log_admin_event: the event's category
--                  (financial fees, academic academics, provisioning
--                  people, access full admin). guard_profile_self_edit: the
--                  people area may change someone else's record the way the
--                  office does, never a full admin's and never into one.

-- ---------------------------------------------------------------- policies: may_administer -> has_perm

-- academics
alter policy assignment_delete on assignments
  using ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (set_by = auth.uid()))));
alter policy assignment_insert on assignments
  with check ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (set_by = auth.uid()) AND may_teach_class_subject(tenant_id, class_id, subject_id))));
alter policy assignment_read on assignments
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (is_staff() OR (class_id IN ( SELECT s.class_id
   FROM students s
  WHERE (s.id IN ( SELECT my_students() AS my_students))))))));
alter policy assignment_update on assignments
  using ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (set_by = auth.uid()))))
  with check ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (set_by = auth.uid()) AND may_teach_class_subject(tenant_id, class_id, subject_id))));
alter policy cbe_comment_read on cbe_assessment_comments
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND is_staff()) OR ((student_id IN ( SELECT my_students() AS my_students)) AND (EXISTS ( SELECT 1
   FROM cbe_assessments a
  WHERE ((a.id = cbe_assessment_comments.assessment_id) AND (a.published_at IS NOT NULL)))))));
alter policy cbe_assessment_read on cbe_assessments
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (is_staff() OR (published_at IS NOT NULL)))));
alter policy cbe_result_read on cbe_results
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND is_staff()) OR ((student_id IN ( SELECT my_students() AS my_students)) AND (EXISTS ( SELECT 1
   FROM cbe_assessments a
  WHERE ((a.id = cbe_results.assessment_id) AND (a.published_at IS NOT NULL)))))));
alter policy class_links_read on class_meeting_links
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy class_links_write on class_meeting_links
  using ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND may_set_class_link(class_id, subject_id))))
  with check ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND may_set_class_link(class_id, subject_id))));
alter policy classes_read on classes
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy classes_write on classes
  using (has_perm(tenant_id, 'academics'))
  with check (has_perm(tenant_id, 'academics'));
alter policy course_assessment_read on course_assessments
  using ((is_super() OR ((tenant_id = my_tenant()) AND (is_staff() OR (published_at IS NOT NULL))) OR has_perm(tenant_id, 'academics')));
alter policy course_assessment_write on course_assessments
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND teaches_section(course_section_id))))
  with check ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND teaches_section(course_section_id))));
alter policy course_grade_read on course_grades
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'academics') OR (student_id IN ( SELECT s.id
   FROM students s
  WHERE (s.profile_id = auth.uid())))));
alter policy course_grade_write on course_grades
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND teaches_section(course_section_id))))
  with check ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND teaches_section(course_section_id))));
alter policy course_mark_read on course_marks
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'academics') OR ((student_id IN ( SELECT s.id
   FROM students s
  WHERE (s.profile_id = auth.uid()))) AND (EXISTS ( SELECT 1
   FROM course_assessments a
  WHERE ((a.id = course_marks.assessment_id) AND (a.published_at IS NOT NULL)))))));
alter policy course_mark_write on course_marks
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (EXISTS ( SELECT 1
   FROM course_assessments a
  WHERE ((a.id = course_marks.assessment_id) AND teaches_section(a.course_section_id)))))))
  with check ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (EXISTS ( SELECT 1
   FROM course_assessments a
  WHERE ((a.id = course_marks.assessment_id) AND teaches_section(a.course_section_id)))))));
alter policy course_section_timetable_read on course_section_timetable_slots
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy course_section_timetable_write on course_section_timetable_slots
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')));
alter policy course_section_read on course_sections
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy course_section_write on course_sections
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')));
alter policy courses_read on courses
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy courses_write on courses
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')));
alter policy coverage_read on coverage_assignments
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy coverage_write on coverage_assignments
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')));
alter policy enrollment_write on enrollments
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')));
alter policy exam_attempts_read on exam_attempts
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND is_staff() AND may_edit_exam_paper(paper_id)) OR ((student_id IN ( SELECT my_students() AS my_students)) AND exam_results_released(paper_id))));
alter policy exam_papers_read on exam_papers
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (is_staff() OR ((published_at IS NOT NULL) AND (class_id IN ( SELECT my_family_class_ids() AS my_family_class_ids)))))));
alter policy exam_read on exams
  using ((is_super() OR ((tenant_id = my_tenant()) AND (is_staff() OR (published_at IS NOT NULL))) OR has_perm(tenant_id, 'academics')));
alter policy exam_write on exams
  using (has_perm(tenant_id, 'academics'))
  with check (has_perm(tenant_id, 'academics'));
alter policy learner_competencies_read on learner_competencies
  using ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND is_staff())));
alter policy learning_materials_read on learning_materials
  using ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (is_staff() OR ((published_at IS NOT NULL) AND (class_id IN ( SELECT my_family_class_ids() AS my_family_class_ids)))))));
alter policy live_classes_read on live_classes
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy mark_publications_read on mark_publications
  using ((is_super() OR has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND is_staff())));
alter policy mark_read on marks
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'academics') OR ((student_id IN ( SELECT my_students() AS my_students)) AND (EXISTS ( SELECT 1
   FROM students s
  WHERE ((s.id = marks.student_id) AND marks_published(marks.exam_id, s.class_id, marks.subject_id)))))));
alter policy mark_write on marks
  using ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (EXISTS ( SELECT 1
   FROM (teaching_assignments ta
     JOIN students s ON ((s.id = marks.student_id)))
  WHERE ((ta.teacher_id = auth.uid()) AND (ta.subject_id = marks.subject_id) AND (ta.class_id = s.class_id)))))))
  with check ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (EXISTS ( SELECT 1
   FROM (teaching_assignments ta
     JOIN students s ON ((s.id = marks.student_id)))
  WHERE ((ta.teacher_id = auth.uid()) AND (ta.subject_id = marks.subject_id) AND (ta.class_id = s.class_id)))))));
alter policy online_lessons_read on online_lessons
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy online_lessons_write on online_lessons
  using ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND may_set_class_link(class_id, subject_id))))
  with check ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND may_set_class_link(class_id, subject_id))));
alter policy remote_days_read on remote_days
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy remote_days_write on remote_days
  using (has_perm(tenant_id, 'academics'))
  with check (has_perm(tenant_id, 'academics'));
alter policy report_cards_read on report_cards
  using ((has_perm(tenant_id, 'academics') OR ((tenant_id = my_tenant()) AND is_staff()) OR ((published_at IS NOT NULL) AND (student_id IN ( SELECT my_students() AS my_students)))));
alter policy report_cards_write on report_cards
  using (has_perm(tenant_id, 'academics'))
  with check (has_perm(tenant_id, 'academics'));
alter policy strand_read on strands
  using (((tenant_id IS NULL) OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy strand_write_school on strands
  using (((tenant_id IS NOT NULL) AND has_perm(tenant_id, 'academics')))
  with check (((tenant_id IS NOT NULL) AND has_perm(tenant_id, 'academics')));
alter policy subjects_read on subjects
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy subjects_write on subjects
  using (has_perm(tenant_id, 'academics'))
  with check (has_perm(tenant_id, 'academics'));
alter policy teacher_subjects_read on teacher_subjects
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy teacher_subjects_write on teacher_subjects
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')));
alter policy teaching_read on teaching_assignments
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy teaching_write on teaching_assignments
  using (has_perm(tenant_id, 'academics'))
  with check (has_perm(tenant_id, 'academics'));
alter policy timetable_read on timetable_slots
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'academics')));
alter policy timetable_write on timetable_slots
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'academics')));

-- activities
alter policy activities_delete on activities
  using (has_perm(tenant_id, 'activities'));
alter policy activities_insert on activities
  with check (has_perm(tenant_id, 'activities'));
alter policy activities_read on activities
  using ((has_perm(tenant_id, 'activities') OR (tenant_id = my_tenant())));
alter policy activity_event_participants_read on activity_event_participants
  using ((has_perm(tenant_id, 'activities') OR ((tenant_id = my_tenant()) AND (is_staff() OR (student_id IN ( SELECT my_students() AS my_students))))));
alter policy activity_events_read on activity_events
  using ((has_perm(tenant_id, 'activities') OR (tenant_id = my_tenant())));
alter policy activity_members_read on activity_members
  using ((has_perm(tenant_id, 'activities') OR ((tenant_id = my_tenant()) AND (is_staff() OR (student_id IN ( SELECT my_students() AS my_students))))));
alter policy activity_patrons_read on activity_patrons
  using ((has_perm(tenant_id, 'activities') OR (tenant_id = my_tenant())));
alter policy activity_patrons_write on activity_patrons
  using (has_perm(tenant_id, 'activities'))
  with check (has_perm(tenant_id, 'activities'));

-- attendance
alter policy attendance_write on attendance
  using ((has_perm(tenant_id, 'attendance') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (EXISTS ( SELECT 1
   FROM teaching_assignments ta
  WHERE ((ta.teacher_id = auth.uid()) AND (ta.class_id = attendance.class_id))))) OR ((tenant_id = my_tenant()) AND (EXISTS ( SELECT 1
   FROM classes c
  WHERE ((c.id = attendance.class_id) AND (c.class_teacher_id = auth.uid())))))))
  with check ((has_perm(tenant_id, 'attendance') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (EXISTS ( SELECT 1
   FROM teaching_assignments ta
  WHERE ((ta.teacher_id = auth.uid()) AND (ta.class_id = attendance.class_id))))) OR ((tenant_id = my_tenant()) AND (EXISTS ( SELECT 1
   FROM classes c
  WHERE ((c.id = attendance.class_id) AND (c.class_teacher_id = auth.uid())))))));

-- communication
alter policy announcement_delete on announcements
  using ((has_perm(tenant_id, 'communication') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (author_id = auth.uid()))));
alter policy announcement_read on announcements
  using ((is_super() OR has_perm(tenant_id, 'communication') OR (author_id = auth.uid()) OR ((published_at IS NOT NULL) AND announcement_visible_to_me(tenant_id, audience))));
alter policy announcement_update on announcements
  using ((has_perm(tenant_id, 'communication') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (author_id = auth.uid()))))
  with check ((has_perm(tenant_id, 'communication') OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (author_id = auth.uid()) AND teacher_may_address(tenant_id, audience))));
alter policy calls_read on calls
  using (((caller_id = auth.uid()) OR (callee_id = auth.uid()) OR has_perm(tenant_id, 'communication')));

-- fees
alter policy invoice_read on fee_invoices
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'fees') OR (EXISTS ( SELECT 1
   FROM guardians g
  WHERE ((g.student_id = fee_invoices.student_id) AND (g.profile_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM students s
  WHERE ((s.id = fee_invoices.student_id) AND (s.profile_id = auth.uid()))))));
alter policy invoice_write on fee_invoices
  using (has_perm(tenant_id, 'fees'))
  with check (has_perm(tenant_id, 'fees'));
alter policy fee_item_read on fee_items
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'fees')));
alter policy fee_item_write on fee_items
  using (has_perm(tenant_id, 'fees'))
  with check (has_perm(tenant_id, 'fees'));
alter policy payment_proofs_office_manage on payment_proofs
  using (has_perm(tenant_id, 'fees'))
  with check (has_perm(tenant_id, 'fees'));
alter policy payment_proofs_read on payment_proofs
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'fees') OR (EXISTS ( SELECT 1
   FROM (fee_invoices i
     JOIN guardians g ON ((g.student_id = i.student_id)))
  WHERE ((i.id = payment_proofs.invoice_id) AND (g.profile_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM (fee_invoices i
     JOIN students s ON ((s.id = i.student_id)))
  WHERE ((i.id = payment_proofs.invoice_id) AND (s.profile_id = auth.uid()))))));
alter policy payment_read on payments
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'fees') OR (EXISTS ( SELECT 1
   FROM (fee_invoices i
     JOIN guardians g ON ((g.student_id = i.student_id)))
  WHERE ((i.id = payments.invoice_id) AND (g.profile_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM (fee_invoices i
     JOIN students s ON ((s.id = i.student_id)))
  WHERE ((i.id = payments.invoice_id) AND (s.profile_id = auth.uid()))))));

-- inventory
alter policy inventory_issues_insert on inventory_issues
  with check (has_perm(tenant_id, 'inventory'));
alter policy inventory_issues_read on inventory_issues
  using ((is_super() OR has_perm(tenant_id, 'inventory') OR ((tenant_id = my_tenant()) AND is_staff()) OR (profile_id = auth.uid()) OR (student_id IN ( SELECT my_students() AS my_students))));
alter policy inventory_issues_update on inventory_issues
  using (has_perm(tenant_id, 'inventory'))
  with check (has_perm(tenant_id, 'inventory'));
alter policy inventory_items_read on inventory_items
  using ((is_super() OR has_perm(tenant_id, 'inventory') OR ((tenant_id = my_tenant()) AND is_staff()) OR (EXISTS ( SELECT 1
   FROM inventory_issues i
  WHERE ((i.item_id = inventory_items.id) AND ((i.profile_id = auth.uid()) OR (i.student_id IN ( SELECT my_students() AS my_students))))))));
alter policy inventory_items_write on inventory_items
  using (has_perm(tenant_id, 'inventory'))
  with check (has_perm(tenant_id, 'inventory'));

-- leave
alter policy leave_read on leave_requests
  using ((is_super() OR has_perm(tenant_id, 'leave') OR ((tenant_id = my_tenant()) AND ((my_role() = 'school_admin'::app_role) OR (teacher_id = auth.uid())))));
alter policy leave_update on leave_requests
  using ((is_super() OR has_perm(tenant_id, 'leave') OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR ((tenant_id = my_tenant()) AND (teacher_id = auth.uid()) AND (status = 'pending'::leave_status))))
  with check ((is_super() OR has_perm(tenant_id, 'leave') OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR ((tenant_id = my_tenant()) AND (teacher_id = auth.uid()))));

-- people
alter policy guardian_write on guardians
  using (has_perm(tenant_id, 'people'))
  with check (has_perm(tenant_id, 'people'));
alter policy password_reset_requests_admin_read on password_reset_requests
  using (has_perm(tenant_id, 'people'));
alter policy student_bio_requests_read on student_bio_requests
  using ((has_perm(tenant_id, 'people') OR (student_id IN ( SELECT my_students() AS my_students))));
alter policy student_documents_office_write on student_documents
  using (has_perm(tenant_id, 'people'))
  with check (has_perm(tenant_id, 'people'));
alter policy student_documents_read on student_documents
  using ((is_super() OR has_perm(tenant_id, 'people') OR ((tenant_id = my_tenant()) AND (is_staff() OR (student_id IN ( SELECT my_students() AS my_students))))));
alter policy student_health_admin_write on student_health
  using (has_perm(tenant_id, 'people'))
  with check (has_perm(tenant_id, 'people'));
alter policy student_write on students
  using (has_perm(tenant_id, 'people'))
  with check (has_perm(tenant_id, 'people'));

-- transport
alter policy route_stops_read on route_stops
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'transport')));
alter policy route_stops_write on route_stops
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')));
alter policy routes_read on routes
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'transport')));
alter policy routes_write on routes
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')));
alter policy student_transport_read on student_transport
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'transport') OR (student_id IN ( SELECT my_students() AS my_students))));
alter policy student_transport_write on student_transport
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')));
alter policy trip_riders_admin_write on trip_riders
  using (has_perm(tenant_id, 'transport'))
  with check (has_perm(tenant_id, 'transport'));
alter policy trip_riders_read on trip_riders
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'transport') OR (student_id IN ( SELECT my_students() AS my_students)) OR (EXISTS ( SELECT 1
   FROM trips t
  WHERE ((t.id = trip_riders.trip_id) AND (t.driver_id = auth.uid()))))));
alter policy trips_read on trips
  using ((is_super() OR ((tenant_id = my_tenant()) AND (is_staff() OR (driver_id = auth.uid()))) OR has_perm(tenant_id, 'transport')));
alter policy trips_staff_write on trips
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')));
alter policy vehicle_alerts_ack on vehicle_alerts
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'transport')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'transport')));
alter policy vehicle_alerts_read on vehicle_alerts
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'transport')));
alter policy vehicle_assignments_read on vehicle_assignments
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'transport')));
alter policy vehicle_assignments_write on vehicle_assignments
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')));
alter policy vehicle_locations_read_staff on vehicle_locations
  using ((is_super() OR ((tenant_id = my_tenant()) AND is_staff()) OR has_perm(tenant_id, 'transport')));
alter policy vehicles_read on vehicles
  using ((is_super() OR (tenant_id = my_tenant()) OR has_perm(tenant_id, 'transport')));
alter policy vehicles_write on vehicles
  using ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')))
  with check ((is_super() OR ((tenant_id = my_tenant()) AND (my_role() = 'school_admin'::app_role)) OR has_perm(tenant_id, 'transport')));

-- ---------------------------------------------------------------- policies by hand

-- people: the office's management of accounts, minus the ways up. A full
-- admin's profile, your own, and making anyone a full admin stay with full
-- admins (guard_profile_self_edit below holds the same line for updates).
alter policy profile_admin_manage on profiles
  using (may_administer(tenant_id)
         or (has_perm(tenant_id, 'people') and id <> auth.uid()
             and role in ('teacher', 'staff', 'driver', 'parent', 'student')))
  with check (may_administer(tenant_id)
         or (has_perm(tenant_id, 'people') and id <> auth.uid()
             and role in ('teacher', 'staff', 'driver', 'parent', 'student')));

-- Any area but the visitor log lists the school's people: as 20260916110000
-- otherwise, plus has_office_perm(). Teachers already pass is_staff().
alter policy profile_read_self on profiles
  using ((id = auth.uid()) OR is_super() OR ((tenant_id = my_tenant()) AND is_staff())
         OR ((role = 'org_admin'::app_role) AND (id IN ( SELECT organization_admins.profile_id
              FROM organization_admins
             WHERE (organization_admins.organization_id IN ( SELECT my_organization_ids() AS my_organization_ids)))))
         OR has_office_perm(tenant_id));
alter policy student_read on students
  using (is_super() OR (id IN ( SELECT my_students() AS my_students)) OR has_office_perm(tenant_id));
alter policy guardian_read on guardians
  using (is_super() OR (profile_id = auth.uid()) OR ((tenant_id = my_tenant()) AND is_staff()) OR has_office_perm(tenant_id));

-- attendance: the area corrects any class's register (attendance_write above), so it reads them all
alter policy attendance_read on attendance
  using (is_super() OR (student_id IN ( SELECT my_students() AS my_students)) OR has_perm(tenant_id, 'attendance'));

-- medical reads learners' health records; people keeps them up to date
alter policy student_health_read on student_health
  using (has_perm(tenant_id, 'people') OR has_perm(tenant_id, 'medical')
         OR ((tenant_id = my_tenant()) AND is_staff()) OR (student_id IN ( SELECT my_students() AS my_students)));

-- communication sends notices; anyone holding an area may also send one
-- person a direct note (Leave tells the teacher the decision, the
-- attendance home reminds a class teacher)
alter policy announcement_insert on announcements
  with check (has_perm(tenant_id, 'communication')
              OR ((tenant_id = my_tenant()) AND (my_role() = 'teacher'::app_role) AND (author_id = auth.uid())
                  AND teacher_may_address(tenant_id, audience))
              OR (has_office_perm(tenant_id) AND (author_id = auth.uid()) AND ((audience ->> 'kind'::text) = 'user'::text)));

-- visitors: the visitor log, replacing "may_administer or is_front_desk()"
alter policy visits_read on visits
  using (has_perm(tenant_id, 'visitors') OR ((tenant_id = my_tenant()) AND (host_id = auth.uid())));
alter policy visits_insert on visits
  with check (has_perm(tenant_id, 'visitors'));
alter policy visits_update on visits
  using (has_perm(tenant_id, 'visitors'))
  with check (has_perm(tenant_id, 'visitors'));

-- signatures: the area of the document signed
alter policy signature_requests_read on signature_requests
  using ((signer_id = auth.uid()) OR has_perm(tenant_id, signed_doc_area(doc_kind)) OR ((tenant_id = my_tenant()) AND is_staff()));
alter policy signatures_read on signatures
  using ((signer_id = auth.uid()) OR has_perm(tenant_id, signed_doc_area(doc_kind)) OR ((tenant_id = my_tenant()) AND is_staff()));

-- storage: the area of the folder (private_doc_area)
alter policy private_docs_office_write on storage.objects
  using ((bucket_id = 'private-documents'::text)
         AND has_perm(((storage.foldername(name))[1])::uuid, private_doc_area((storage.foldername(name))[2])))
  with check ((bucket_id = 'private-documents'::text)
         AND has_perm(((storage.foldername(name))[1])::uuid, private_doc_area((storage.foldername(name))[2])));
alter policy private_docs_read on storage.objects
  using ((bucket_id = 'private-documents'::text) AND (is_super()
    OR has_perm(((storage.foldername(name))[1])::uuid, private_doc_area((storage.foldername(name))[2]))
    OR (((storage.foldername(name))[1] = (my_tenant())::text) AND (is_staff()
      OR (((storage.foldername(name))[2] = 'students'::text) AND ((storage.foldername(name))[3] IN ( SELECT (id.id)::text AS id
           FROM my_students() id(id))))
      OR (((storage.foldername(name))[2] = 'submissions'::text) AND ((storage.foldername(name))[4] IN ( SELECT (id.id)::text AS id
           FROM my_students() id(id))))
      OR (((storage.foldername(name))[2] = 'invoices'::text) AND (EXISTS ( SELECT 1
           FROM fee_invoices i
          WHERE (((i.id)::text = (storage.foldername(objects.name))[3]) AND (i.student_id IN ( SELECT my_students() AS my_students))))))))));
-- photos (avatars/) are people's; the school's branding stays with full admins
alter policy public_assets_write on storage.objects
  using ((bucket_id = 'public-assets'::text) AND (is_super()
    OR (is_staff() AND ((storage.foldername(name))[1] = (my_tenant())::text))
    OR has_perm(((storage.foldername(name))[1])::uuid, case when (storage.foldername(name))[2] = 'avatars' then 'people' end)))
  with check ((bucket_id = 'public-assets'::text) AND (is_super()
    OR (is_staff() AND ((storage.foldername(name))[1] = (my_tenant())::text))
    OR has_perm(((storage.foldername(name))[1])::uuid, case when (storage.foldername(name))[2] = 'avatars' then 'people' end)));

-- ---------------------------------------------------------------- functions: may_administer -> has_perm
-- (full definitions, as last defined, with only the admin check changed)

-- ---------------------------------------------------------------- academics

create or replace function class_exam_performance(p_tenant_id uuid, p_class_id uuid DEFAULT NULL::uuid) returns TABLE(exam_id uuid, exam_name text, term_id uuid, term_name text, term_starts_on date, published_at timestamp with time zone, class_id uuid, class_name text, subject_id uuid, subject_name text, teacher_id uuid, teacher_name text, learners integer, mean_score numeric, scores integer[])
language sql stable security definer set search_path = public as $$
  select e.id, e.name, t.id, t.name, t.starts_on, e.published_at,
         c.id, c.name, sub.id, sub.name,
         ta.teacher_id, p.full_name,
         count(*)::int, round(avg(m.score), 1), array_agg(m.score order by m.score)
    from mark_publications mp
    join exams e on e.id = mp.exam_id
    join terms t on t.id = e.term_id
    join classes c on c.id = mp.class_id
    join subjects sub on sub.id = mp.subject_id
    join marks m on m.exam_id = mp.exam_id and m.subject_id = mp.subject_id
    join students s on s.id = m.student_id and s.class_id = mp.class_id
    left join teaching_assignments ta on ta.class_id = mp.class_id and ta.subject_id = mp.subject_id
    left join profiles p on p.id = ta.teacher_id
   where mp.tenant_id = p_tenant_id
     and (p_class_id is null or mp.class_id = p_class_id)
     and m.score is not null
     and (has_perm(p_tenant_id, 'academics') or (p_tenant_id = my_tenant() and is_staff()))
   group by e.id, e.name, t.id, t.name, t.starts_on, e.published_at, c.id, c.name, sub.id, sub.name, ta.teacher_id, p.full_name
$$;

create or replace function class_learner_exam_means(p_class_id uuid) returns TABLE(exam_id uuid, student_id uuid, full_name text, mean_score numeric, subjects integer)
language sql stable security definer set search_path = public as $$
  select m.exam_id, s.id, s.full_name, round(avg(m.score), 1), count(*)::int
    from students s
    join marks m on m.student_id = s.id
   where s.class_id = p_class_id
     and s.active
     and m.score is not null
     and marks_published(m.exam_id, p_class_id, m.subject_id)
     and (has_perm(s.tenant_id, 'academics') or (s.tenant_id = my_tenant() and is_staff()))
   group by m.exam_id, s.id, s.full_name
$$;

create or replace function exam_paper_open_to_me(p_paper_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from exam_papers p
     where p.id = p_paper_id
       and (
         is_super() or has_perm(p.tenant_id, 'academics')
         or (p.tenant_id = my_tenant() and is_staff())
         or (p.tenant_id = my_tenant() and p.published_at is not null and p.opens_at <= now()
             and p.class_id in (select my_family_class_ids()))
       )
  )
$$;

create or replace function learner_results_history(p_student_id uuid) returns TABLE(exam_id uuid, exam_name text, term_id uuid, term_name text, term_starts_on date, published_at timestamp with time zone, subject_id uuid, subject_name text, score integer, class_mean numeric)
language sql stable security definer set search_path = public as $$
  with learner as (
    select s.id, s.class_id, s.tenant_id
      from students s
     where s.id = p_student_id
       and (
         s.id in (select my_students())
         or (s.tenant_id = my_tenant() and is_staff())
         or has_perm(s.tenant_id, 'academics')
       )
  )
  select e.id, e.name, t.id, t.name, t.starts_on, e.published_at,
         sub.id, sub.name, m.score,
         (select round(avg(cm.score), 1)
            from marks cm join students cs on cs.id = cm.student_id
           where cm.exam_id = m.exam_id and cm.subject_id = m.subject_id
             and cs.class_id = l.class_id and cm.score is not null)
    from learner l
    join marks m on m.student_id = l.id
    join exams e on e.id = m.exam_id
    join terms t on t.id = e.term_id
    join subjects sub on sub.id = m.subject_id
   where m.score is not null
     and marks_published(m.exam_id, l.class_id, m.subject_id)
$$;

create or replace function learning_media_admin(p_tenant text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tenants t where t.id::text = p_tenant and has_perm(t.id, 'academics'))
$$;

create or replace function live_class_role(p_live_class_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when has_perm(lc.tenant_id, 'academics')
      or (lc.tenant_id = my_tenant() and may_set_class_link(lc.class_id, null)) then 'host'
    when exists (select 1 from students s where s.class_id = lc.class_id and s.profile_id = auth.uid() and s.active) then 'learner'
    when exists (
      select 1 from guardians g join students s on s.id = g.student_id
      where g.profile_id = auth.uid() and s.class_id = lc.class_id and s.active) then 'family'
  end
  from live_classes lc
  where lc.id = p_live_class_id
$$;

create or replace function material_open_to_me(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from learning_materials m
     where m.id = p_id
       and (
         has_perm(m.tenant_id, 'academics')
         or (m.tenant_id = my_tenant() and is_staff())
         or (m.tenant_id = my_tenant() and m.published_at is not null
             and m.class_id in (select my_family_class_ids()))
       )
  )
$$;

create or replace function may_assess(p_tenant uuid, p_class uuid, p_subject uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_perm(p_tenant, 'academics')
    or (p_tenant = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          where ta.teacher_id = auth.uid() and ta.class_id = p_class and ta.subject_id = p_subject))
$$;

create or replace function may_change_assignment(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from assignments a
     where a.id = p_id
       and (
         has_perm(a.tenant_id, 'academics')
         or (a.tenant_id = my_tenant() and my_role() = 'teacher' and a.set_by = auth.uid())
       )
  )
$$;

create or replace function may_host_class(p_class_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from classes c
    where c.id = p_class_id
      and (has_perm(c.tenant_id, 'academics') or (c.tenant_id = my_tenant() and may_set_class_link(p_class_id, null)))
  )
$$;

create or replace function may_mark_submission(p_assignment_id uuid, p_student_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from assignments a
    join students s on s.id = p_student_id and s.class_id = a.class_id and s.tenant_id = a.tenant_id
    join classes c on c.id = s.class_id
    where a.id = p_assignment_id
      and (
        s.profile_id = auth.uid()
        or (s.tenant_id = my_tenant() and is_staff())
        or has_perm(s.tenant_id, 'academics')
        or (is_young_class(c.level, c.form_level) and exists (
              select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid()))
      )
  )
$$;

create or replace function may_rate_competencies(p_tenant uuid, p_student uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_perm(p_tenant, 'academics')
    or (p_tenant = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from students s join classes c on c.id = s.class_id
          where s.id = p_student and s.tenant_id = p_tenant and c.class_teacher_id = auth.uid()))
$$;

create or replace function may_read_assignment(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from assignments a
     where a.id = p_id
       and (
         has_perm(a.tenant_id, 'academics')
         or (a.tenant_id = my_tenant() and (
               is_staff()
               or a.class_id in (select s.class_id from students s where s.id in (select my_students()))
             ))
       )
  )
$$;

create or replace function may_read_exam_questions(p_paper_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from exam_papers p
     where p.id = p_paper_id
       and (
         is_super() or has_perm(p.tenant_id, 'academics')
         or (p.tenant_id = my_tenant() and is_staff())
         or (p.tenant_id = my_tenant() and p.published_at is not null and (
               exists (select 1 from exam_attempts a join students s on s.id = a.student_id
                        where a.paper_id = p.id and s.profile_id = auth.uid())
               or (p.results_released_at is not null and p.class_id in (select my_family_class_ids()))
             ))
       )
  )
$$;

create or replace function may_teach_class_subject(p_tenant_id uuid, p_class_id uuid, p_subject_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_perm(p_tenant_id, 'academics')
      or (
        p_tenant_id = my_tenant() and my_role() = 'teacher'
        and exists (
          select 1 from teaching_assignments ta
           where ta.teacher_id = auth.uid() and ta.class_id = p_class_id and ta.subject_id = p_subject_id
        )
      )
$$;

create or replace function set_report_card_teacher_comment(p_card_id uuid, p_comment text) returns void
language plpgsql security definer set search_path = public as $$
declare
  c report_cards;
begin
  select * into c from report_cards where id = p_card_id for update;
  if c.id is null then
    raise exception 'That report card no longer exists.' using errcode = '22023';
  end if;
  if not (
    has_perm(c.tenant_id, 'academics')
    or (c.tenant_id = my_tenant() and my_role() = 'teacher'
        and exists (select 1 from classes where id = c.class_id and class_teacher_id = auth.uid()))
  ) then
    raise exception 'Only the class teacher can comment on this report card.' using errcode = '42501';
  end if;
  if c.published_at is not null and not has_perm(c.tenant_id, 'academics') then
    raise exception 'This report card has gone out to the family. Ask the office to withdraw it to change the comment.' using errcode = '42501';
  end if;
  update report_cards
     set teacher_comment = nullif(left(trim(coalesce(p_comment, '')), 600), '')
   where id = c.id;
end $$;

-- ---------------------------------------------------------------- activities

create or replace function activities_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id then
      raise exception 'An activity can''t move to another school.' using errcode = '42501';
    end if;
    if not has_perm(old.tenant_id, 'activities')
       and (new.name is distinct from old.name or new.category is distinct from old.category or new.active is distinct from old.active) then
      raise exception 'Only the school office can rename, recategorise or close an activity.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function may_manage_activity(p_activity_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from activities a
     where a.id = p_activity_id
       and (
         has_perm(a.tenant_id, 'activities')
         or (a.tenant_id = my_tenant() and my_role() = 'teacher'
             and exists (select 1 from activity_patrons p where p.activity_id = a.id and p.teacher_id = auth.uid()))
       )
  )
$$;

-- ---------------------------------------------------------------- by hand

create or replace function guard_profile_self_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- service role (edge functions, seeds) and anyone administering this school
  if auth.uid() is null or may_administer(old.tenant_id)
     -- the people area (20261030000001): someone else's record, never a
     -- full admin's, and never making anyone one
     or (old.id <> auth.uid() and has_perm(old.tenant_id, 'people')
         and old.role in ('teacher', 'staff', 'driver', 'parent', 'student')
         and new.role in ('teacher', 'staff', 'driver', 'parent', 'student'))
  then
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

create or replace function log_admin_event(p_tenant_id uuid, p_event text, p_category text, p_metadata jsonb DEFAULT '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_perm(p_tenant_id, case p_category when 'financial' then 'fees' when 'academic' then 'academics'
                                             when 'provisioning' then 'people' end) then
    raise exception 'You do not administer this school.' using errcode = '42501';
  end if;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p_tenant_id, auth.uid(), my_actor_label(), p_event, p_category, coalesce(p_metadata, '{}'::jsonb));
end $$;

create or replace function signature_status(p_kind text, p_ids uuid[]) returns TABLE(doc_id uuid, signer_id uuid, signer_name text, capacity text, requested_at timestamp with time zone, signed_at timestamp with time zone)
language sql stable security definer set search_path = public as $$
  select r.doc_id, r.signer_id, p.full_name, r.capacity, r.requested_at, x.signed_at
    from signature_requests r
    join profiles p on p.id = r.signer_id
    left join signatures x on x.doc_kind = r.doc_kind and x.doc_id = r.doc_id and x.signer_id = r.signer_id
                          and x.capacity = r.capacity and x.voided_at is null
   where r.doc_kind = p_kind
     and r.doc_id = any(p_ids)
     and (has_perm(r.tenant_id, signed_doc_area(r.doc_kind)) or (r.tenant_id = my_tenant() and is_staff()))
   order by x.signed_at nulls first, p.full_name
$$;

create or replace function visit_find_learners(p_tenant_id uuid, p_query text) returns TABLE(id uuid, full_name text, admission_no text, class_name text)
language sql stable security definer set search_path = public as $$
  select s.id, s.full_name, s.admission_no, c.name
  from students s
  left join classes c on c.id = s.class_id
  where s.tenant_id = p_tenant_id
    and s.active
    and char_length(trim(coalesce(p_query, ''))) >= 2
    and (s.full_name ilike '%' || trim(p_query) || '%' or s.admission_no ilike trim(p_query) || '%')
    and has_perm(p_tenant_id, 'visitors')
  order by s.full_name
  limit 8
$$;

create or replace function visit_hosts(p_tenant_id uuid) returns TABLE(id uuid, full_name text, role app_role, staff_title text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role, p.staff_title
  from profiles p
  where p.tenant_id = p_tenant_id
    and p.role in ('teacher', 'school_admin')
    and has_perm(p_tenant_id, 'visitors')
  order by p.full_name
$$;

create or replace function void_signature(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_kind   text;
begin
  select tenant_id, doc_kind into v_tenant, v_kind from signatures where id = p_id and voided_at is null;
  if v_tenant is null or not has_perm(v_tenant, signed_doc_area(v_kind)) then
    raise exception 'Only the school office can void a signature' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 300 then
    raise exception 'Say why the signature is being voided' using errcode = '22023';
  end if;
  update signatures set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason) where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- communication

create or replace function may_change_announcement(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from announcements a
     where a.id = p_id
       and (
         has_perm(a.tenant_id, 'communication')
         or (a.tenant_id = my_tenant() and my_role() = 'teacher' and a.author_id = auth.uid())
       )
  )
$$;

create or replace function may_read_announcement(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from announcements a
     where a.id = p_id
       and (
         is_super()
         or has_perm(a.tenant_id, 'communication')
         or a.author_id = auth.uid()
         or (a.published_at is not null and announcement_visible_to_me(a.tenant_id, a.audience))
       )
  )
$$;

create or replace function may_read_conversation(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_conversation_member(p_conversation_id)
      or exists (select 1 from conversations c where c.id = p_conversation_id and has_perm(c.tenant_id, 'communication'))
$$;

create or replace function school_conversations(p_tenant_id uuid, p_student_id uuid DEFAULT NULL::uuid) returns TABLE(conversation_id uuid, a_id uuid, a_name text, a_role text, b_id uuid, b_name text, b_role text, last_message_at timestamp with time zone, message_count integer, last_body text)
language sql stable security definer set search_path = public as $$
  select c.id,
         pa.id, pa.full_name, pa.role::text,
         pb.id, pb.full_name, pb.role::text,
         c.last_message_at,
         (select count(*)::int from chat_messages m where m.conversation_id = c.id),
         (select coalesce(m.body, m.file_name) from chat_messages m where m.conversation_id = c.id order by m.created_at desc limit 1)
    from conversations c
    join lateral (
      select array_agg(m.profile_id order by m.profile_id) as ids from conversation_members m where m.conversation_id = c.id
    ) mem on true
    join profiles pa on pa.id = mem.ids[1]
    join profiles pb on pb.id = mem.ids[2]
   where c.tenant_id = p_tenant_id
     and has_perm(p_tenant_id, 'communication')
     and c.last_message_at is not null
     and (
       p_student_id is null
       or exists (
         select 1 from students s
          where s.id = p_student_id and s.tenant_id = p_tenant_id
            and (s.profile_id = any (mem.ids)
                 or exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = any (mem.ids)))
       )
     )
   order by c.last_message_at desc
$$;

-- ---------------------------------------------------------------- fees

create or replace function charge_learner(p_student_id uuid, p_amount_cents bigint, p_reason text, p_issue_id uuid DEFAULT NULL::uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_student students;
  v_inv     fee_invoices;
  v_issue   inventory_issues;
  v_reason  text := nullif(trim(p_reason), '');
  v_id      uuid;
begin
  select * into v_student from students where id = p_student_id;
  if v_student.id is null or not has_perm(v_student.tenant_id, 'fees') then
    raise exception 'That learner could not be found.' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Enter the amount to charge.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Say what the charge is for.' using errcode = '22023';
  end if;
  if p_issue_id is not null then
    select * into v_issue from inventory_issues where id = p_issue_id;
    if v_issue.id is null or v_issue.student_id is distinct from p_student_id or v_issue.status not in ('lost', 'damaged') then
      raise exception 'Only an item this learner lost or returned damaged can be charged for.' using errcode = '22023';
    end if;
  end if;

  select i.* into v_inv
    from fee_invoices i join terms t on t.id = i.term_id
   where i.student_id = p_student_id and t.is_current and t.tenant_id = v_student.tenant_id
   for update of i;
  if v_inv.id is null then
    raise exception '% hasn''t been billed for this term yet. Bill the term first, then add the charge.', v_student.full_name
      using errcode = '22023';
  end if;

  begin
    insert into fee_charges (tenant_id, invoice_id, student_id, amount_cents, reason, issue_id, created_by)
    values (v_student.tenant_id, v_inv.id, p_student_id, p_amount_cents, v_reason, p_issue_id, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'That item has already been charged for.' using errcode = '23505';
  end;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    v_student.tenant_id, auth.uid(), my_actor_label(),
    format('Charge added for %s: %s', v_student.full_name, v_reason),
    'financial',
    jsonb_build_object('charge_id', v_id, 'invoice_id', v_inv.id, 'amount_cents', p_amount_cents, 'issue_id', p_issue_id)
  );
  return v_id;
end $$;

create or replace function payment_proofs_check_sms() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  NEW.txn_code := nullif(upper(trim(NEW.txn_code)), '');
  NEW.sms_text := nullif(trim(NEW.sms_text), '');

  -- A family submits a proof; only the office reviews one.
  if TG_OP = 'INSERT' and not (is_super() or (NEW.tenant_id = my_tenant() and is_staff()) or has_perm(NEW.tenant_id, 'fees')) then
    NEW.reviewed_by := null;
    NEW.reviewed_at := null;
    NEW.rejection_reason := null;
  end if;

  -- Checked when a code arrives or a rejected proof comes back to life; not
  -- when record_payment() confirms it, by which time its own payment exists.
  if NEW.txn_code is null
     or (TG_OP = 'UPDATE' and NEW.txn_code is not distinct from OLD.txn_code
         and NEW.sms_text is not distinct from OLD.sms_text
         and not (OLD.status = 'rejected' and NEW.status <> 'rejected')) then
    return NEW;
  end if;

  if NEW.sms_text is not null and position(NEW.txn_code in upper(NEW.sms_text)) = 0 then
    raise exception 'The transaction code % is not in the pasted message.', NEW.txn_code using errcode = '22023';
  end if;

  if NEW.status <> 'rejected' and exists (
    select 1 from payment_proofs p
    where p.tenant_id = NEW.tenant_id and p.txn_code = NEW.txn_code and p.status <> 'rejected' and p.id <> NEW.id
  ) then
    raise exception 'Transaction % has already been sent to the school as proof.', NEW.txn_code using errcode = '23505';
  end if;

  if exists (
    select 1 from payments p
    where p.tenant_id = NEW.tenant_id and p.status = 'success'
      and (upper(p.mpesa_receipt) = NEW.txn_code or upper(p.reference) = NEW.txn_code)
  ) then
    raise exception 'Transaction % has already been recorded as a payment.', NEW.txn_code using errcode = '23505';
  end if;

  return NEW;
end;
$$;

create or replace function record_payment(p_invoice_id uuid, p_amount_cents bigint, p_method payment_method, p_reference text, p_proof_id uuid DEFAULT NULL::uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  inv fee_invoices;
  learner text;
  ref text := nullif(trim(p_reference), '');
  payment_id uuid;
begin
  select * into inv from fee_invoices where id = p_invoice_id for update;
  if inv.id is null or not has_perm(inv.tenant_id, 'fees') then
    raise exception 'That invoice could not be found.' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Enter the amount received.' using errcode = '22023';
  end if;
  if p_amount_cents > inv.total_cents - inv.paid_cents then
    raise exception 'That is more than the outstanding balance.' using errcode = '22023';
  end if;
  if ref is null and p_method <> 'cash' then
    raise exception 'Enter the receipt, slip or cheque number.' using errcode = '22023';
  end if;
  if p_method = 'mpesa' then ref := upper(ref); end if;

  begin
    insert into payments (tenant_id, invoice_id, amount_cents, method, mpesa_receipt, reference,
                          status, completed_at, recorded_by)
    values (inv.tenant_id, inv.id, p_amount_cents, p_method,
            case when p_method = 'mpesa' then ref end, ref,
            'success', now(), auth.uid())
    returning id into payment_id;
  exception when unique_violation then
    raise exception 'M-Pesa receipt % has already been recorded.', ref using errcode = '23505';
  end;

  if p_proof_id is not null then
    update payment_proofs
       set status = 'confirmed', reviewed_by = auth.uid(), reviewed_at = now()
     where id = p_proof_id and invoice_id = inv.id and status = 'pending';
    if not found then
      raise exception 'That payment proof is no longer waiting for review on this invoice.' using errcode = '22023';
    end if;
  end if;

  select full_name into learner from students where id = inv.student_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    inv.tenant_id, auth.uid(), my_actor_label(),
    format('%s payment recorded for %s%s',
           case p_method::text when 'mpesa' then 'M-Pesa' else initcap(p_method::text) end, learner,
           case when ref is not null then ', ref ' || ref else '' end),
    'financial',
    jsonb_build_object('invoice_id', inv.id, 'payment_id', payment_id, 'amount_cents', p_amount_cents,
                       'method', p_method, 'proof_id', p_proof_id)
  );

  return payment_id;
end $$;

create or replace function void_fee_charge(p_charge_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_charge  fee_charges;
  v_reason  text := nullif(trim(p_reason), '');
begin
  select * into v_charge from fee_charges where id = p_charge_id for update;
  if v_charge.id is null or not has_perm(v_charge.tenant_id, 'fees') then
    raise exception 'That charge could not be found.' using errcode = '42501';
  end if;
  if v_charge.voided_at is not null then
    raise exception 'That charge has already been cancelled.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Say why the charge is being cancelled.' using errcode = '22023';
  end if;

  update fee_charges set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p_charge_id;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    v_charge.tenant_id, auth.uid(), my_actor_label(),
    format('Charge cancelled for %s: %s (%s)', (select full_name from students where id = v_charge.student_id), v_charge.reason, v_reason),
    'financial',
    jsonb_build_object('charge_id', v_charge.id, 'invoice_id', v_charge.invoice_id, 'amount_cents', v_charge.amount_cents)
  );
end $$;

-- ---------------------------------------------------------------- inventory

create or replace function issue_item_to_class(p_item_id uuid, p_class_id uuid, p_due_on date) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_item   inventory_items%rowtype;
  v_needed int;
  v_free   int;
begin
  select * into v_item from inventory_items where id = p_item_id for update;
  if v_item.id is null or not has_perm(v_item.tenant_id, 'inventory') then
    raise exception 'Only the school office can issue items' using errcode = '42501';
  end if;
  if not exists (select 1 from classes c where c.id = p_class_id and c.tenant_id = v_item.tenant_id) then
    raise exception 'That class is not in this school' using errcode = '42501';
  end if;
  if v_item.tracking <> 'stock' then
    raise exception 'Only a stock item (many copies) can go to a whole class' using errcode = '22023';
  end if;

  select count(*) into v_needed
  from students s
  where s.class_id = p_class_id and s.active and s.tenant_id = v_item.tenant_id
    and not exists (select 1 from inventory_issues i where i.item_id = p_item_id and i.student_id = s.id and i.status = 'out');
  if v_needed = 0 then return 0; end if;

  v_free := v_item.quantity - inventory_out_count(p_item_id);
  if v_needed > v_free then
    raise exception 'The class needs % copies of % but only % are on the shelf', v_needed, v_item.name, greatest(v_free, 0)
      using errcode = '23514';
  end if;

  insert into inventory_issues (tenant_id, item_id, student_id, quantity, due_on)
  select v_item.tenant_id, p_item_id, s.id, 1, p_due_on
  from students s
  where s.class_id = p_class_id and s.active and s.tenant_id = v_item.tenant_id
    and not exists (select 1 from inventory_issues i where i.item_id = p_item_id and i.student_id = s.id and i.status = 'out');
  return v_needed;
end;
$$;

-- ---------------------------------------------------------------- leave

create or replace function guard_leave_review() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or has_perm(coalesce(old.tenant_id, new.tenant_id), 'leave') then return new; end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.reviewed_by is not null or new.reviewed_at is not null or new.review_note is not null then
      raise exception 'A leave request starts pending. Only the office reviews it.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at
     or new.review_note is distinct from old.review_note
     or new.teacher_id is distinct from old.teacher_id
     or new.tenant_id is distinct from old.tenant_id then
    raise exception 'Only the office reviews leave.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (old.status = 'pending' and new.status = 'cancelled') then
    raise exception 'You can withdraw a pending leave request, but only the office approves or rejects it.' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- people

create or replace function archive_learners(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if exists (select 1 from students where id = any (p_ids) and not has_perm(tenant_id, 'people')) then
    raise exception 'You can only archive learners at a school you administer.' using errcode = '42501';
  end if;

  with changed as (
    update students
       set active = false, archived_at = now(), archived_by = auth.uid()
     where id = any (p_ids) and active and has_perm(tenant_id, 'people')
    returning id, tenant_id, full_name
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select tenant_id, auth.uid(), my_actor_label(),
           format('%s learner%s archived', count(*), case when count(*) = 1 then '' else 's' end), 'provisioning',
           jsonb_build_object('student_ids', jsonb_agg(id), 'names', jsonb_agg(full_name))
      from changed group by tenant_id
    returning 1
  )
  select count(*) into n from changed;
  return n;
end $$;

create or replace function decide_bio_request(p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL::text) returns void
language plpgsql security definer set search_path = public as $$
declare
  r      student_bio_requests%rowtype;
  v_name text;
  v_status text;
begin
  select * into r from student_bio_requests where id = p_request_id for update;
  if not found or r.status <> 'pending' then
    raise exception 'That request has already been dealt with' using errcode = '22023';
  end if;

  if has_perm(r.tenant_id, 'people') then
    v_status := case when p_approve then 'approved' else 'rejected' end;
  elsif r.requested_by = auth.uid() and not p_approve then
    v_status := 'withdrawn';
  else
    raise exception 'Only the school office can approve changes to a learner''s details' using errcode = '42501';
  end if;

  if v_status = 'approved' then
    perform apply_bio_identity(r.student_id, r.changes);
    update students set bio_updated_at = now(), bio_updated_by = r.requested_by where id = r.student_id;
  end if;

  update student_bio_requests
  set status = v_status, decided_by = auth.uid(), decided_at = now(), note = nullif(left(trim(coalesce(p_note, '')), 500), '')
  where id = p_request_id;

  select full_name into v_name from students where id = r.student_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (r.tenant_id, auth.uid(), my_actor_label(),
          format('Bio data change %s for %s', v_status, coalesce(v_name, 'a learner')),
          'provisioning',
          jsonb_build_object('student_id', r.student_id, 'request_id', r.id,
                             'fields', to_jsonb(array(select jsonb_object_keys(r.changes)))));
end;
$$;

create or replace function request_signatures(p_doc_id uuid, p_signer_ids uuid[], p_note text DEFAULT NULL::text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_doc   student_documents%rowtype;
  v_count int;
begin
  select * into v_doc from student_documents where id = p_doc_id;
  if v_doc.id is null or not (has_perm(v_doc.tenant_id, 'people') or (v_doc.tenant_id = my_tenant() and is_staff())) then
    raise exception 'Only the school''s staff can ask for signatures' using errcode = '42501';
  end if;

  insert into signature_requests (tenant_id, doc_kind, doc_id, signer_id, capacity, note)
  select v_doc.tenant_id, 'student_document', v_doc.id, p.id,
         case when exists (select 1 from guardians g where g.student_id = v_doc.student_id and g.profile_id = p.id) then 'guardian'
              when p.role = 'student' then 'learner'
              else 'staff' end,
         nullif(left(trim(coalesce(p_note, '')), 300), '')
    from profiles p
   where p.id = any(p_signer_ids)
     and p.tenant_id = v_doc.tenant_id
     and (p.role in ('school_admin', 'teacher')
          or exists (select 1 from guardians g where g.student_id = v_doc.student_id and g.profile_id = p.id)
          or exists (select 1 from students s where s.id = v_doc.student_id and s.profile_id = p.id))
  on conflict (doc_kind, doc_id, signer_id, capacity) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function restore_learners(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if exists (select 1 from students where id = any (p_ids) and not has_perm(tenant_id, 'people')) then
    raise exception 'You can only restore learners at a school you administer.' using errcode = '42501';
  end if;

  with changed as (
    update students
       set active = true, archived_at = null, archived_by = null
     where id = any (p_ids) and not active and has_perm(tenant_id, 'people')
    returning id, tenant_id, full_name
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select tenant_id, auth.uid(), my_actor_label(),
           format('%s learner%s restored', count(*), case when count(*) = 1 then '' else 's' end), 'provisioning',
           jsonb_build_object('student_ids', jsonb_agg(id), 'names', jsonb_agg(full_name))
      from changed group by tenant_id
    returning 1
  )
  select count(*) into n from changed;
  return n;
end $$;

create or replace function set_child_bio(p_student_id uuid, p_bio jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          students%rowtype;
  v_admin    boolean;
  v_field    text;
  v_new      jsonb;
  v_saved    text[] := '{}';
  v_pending  text[] := '{}';
  v_changes  jsonb := '{}'::jsonb;
  v_previous jsonb := '{}'::jsonb;
  v_nat      text;
  v_rel      text;
  v_prev     text;
begin
  select * into s from students where id = p_student_id for update;
  if not found then
    raise exception 'You can only change the details of your own child' using errcode = '42501';
  end if;
  v_admin := has_perm(s.tenant_id, 'people');
  if not v_admin and not exists (select 1 from guardians g where g.student_id = p_student_id and g.profile_id = auth.uid()) then
    raise exception 'You can only change the details of your own child' using errcode = '42501';
  end if;
  if p_bio is null or jsonb_typeof(p_bio) <> 'object' then
    raise exception 'Bio data must be an object' using errcode = '22023';
  end if;

  -- everyday details: applied for anyone allowed here
  v_nat  := case when p_bio ? 'nationality' then nullif(left(trim(coalesce(p_bio->>'nationality', '')), 60), '') else s.nationality end;
  v_rel  := case when p_bio ? 'religion' then nullif(left(trim(coalesce(p_bio->>'religion', '')), 60), '') else s.religion end;
  v_prev := case when p_bio ? 'previous_school' then nullif(left(trim(coalesce(p_bio->>'previous_school', '')), 160), '') else s.previous_school end;
  if v_nat is distinct from s.nationality then v_saved := array_append(v_saved, 'nationality'); end if;
  if v_rel is distinct from s.religion then v_saved := array_append(v_saved, 'religion'); end if;
  if v_prev is distinct from s.previous_school then v_saved := array_append(v_saved, 'previous_school'); end if;

  -- identity details: only the ones that actually change
  foreach v_field in array array['full_name', 'date_of_birth', 'gender', 'birth_cert_no', 'upi_no'] loop
    if p_bio ? v_field then
      v_new := bio_identity_value(v_field, p_bio->v_field);
      if v_new is distinct from bio_identity_current(s, v_field) then
        v_changes := v_changes || jsonb_build_object(v_field, v_new);
        v_previous := v_previous || jsonb_build_object(v_field, bio_identity_current(s, v_field));
      end if;
    end if;
  end loop;

  if cardinality(v_saved) > 0 then
    update students set nationality = v_nat, religion = v_rel, previous_school = v_prev where id = p_student_id;
  end if;

  if v_changes <> '{}'::jsonb then
    if v_admin then
      perform apply_bio_identity(p_student_id, v_changes);
      v_saved := v_saved || array(select jsonb_object_keys(v_changes));
      -- the office has now set these itself: an open request for them is moot
      update student_bio_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
        note = 'Superseded: the office changed these details directly'
      where student_id = p_student_id and status = 'pending' and changes ?| array(select jsonb_object_keys(v_changes));
    else
      v_pending := array(select jsonb_object_keys(v_changes));
      insert into student_bio_requests (tenant_id, student_id, requested_by, changes, previous)
      values (s.tenant_id, p_student_id, auth.uid(), v_changes, v_previous)
      on conflict (student_id) where status = 'pending' do update
        set requested_by = excluded.requested_by,
            -- asking again keeps what was asked before and wasn't asked about now
            changes = student_bio_requests.changes || excluded.changes,
            previous = excluded.previous || student_bio_requests.previous,
            created_at = now();
    end if;
  end if;

  if cardinality(v_saved) > 0 then
    update students set bio_updated_at = now(), bio_updated_by = auth.uid() where id = p_student_id;
  end if;

  if cardinality(v_saved) > 0 or cardinality(v_pending) > 0 then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (s.tenant_id, auth.uid(), my_actor_label(),
            case when cardinality(v_saved) > 0 then format('Bio data updated for %s', s.full_name)
                 else format('Bio data change requested for %s', s.full_name) end,
            'provisioning',
            jsonb_build_object('student_id', p_student_id, 'fields', to_jsonb(v_saved), 'pending_fields', to_jsonb(v_pending)));
  end if;

  return jsonb_build_object('saved', to_jsonb(v_saved), 'pending', to_jsonb(v_pending));
end;
$$;

create or replace function set_child_home(p_student_id uuid, p_lat double precision, p_lng double precision, p_landmark text, p_address text DEFAULT NULL::text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from students where id = p_student_id;
  if v_tenant is null
     or not (exists (select 1 from guardians g where g.student_id = p_student_id and g.profile_id = auth.uid()) or has_perm(v_tenant, 'people')) then
    raise exception 'You can only set the home of your own child' using errcode = '42501';
  end if;
  if (p_lat is null) <> (p_lng is null) then
    raise exception 'Give both latitude and longitude, or neither' using errcode = '22023';
  end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (abs(p_lat) < 0.0001 and abs(p_lng) < 0.0001)) then
    raise exception 'That location is not a real place on the map' using errcode = '22023';
  end if;
  update students
  set home_lat = p_lat, home_lng = p_lng,
      home_landmark = nullif(left(trim(coalesce(p_landmark, '')), 200), ''),
      home_address = case when p_address is null then home_address else nullif(left(trim(p_address), 300), '') end
  where id = p_student_id;
end;
$$;

-- ---------------------------------------------------------------- signatures

create or replace function may_read_signed_document(p_kind text, p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'student_document' then exists (
      select 1 from student_documents d where d.id = p_id
        and (has_perm(d.tenant_id, 'people') or (d.tenant_id = my_tenant() and (is_staff() or d.student_id in (select my_students())))))
    when 'attachment' then exists (
      select 1 from attachments a where a.id = p_id and a.announcement_id is not null and may_read_announcement(a.announcement_id))
    when 'report_card' then exists (
      select 1 from report_cards r where r.id = p_id
        and (has_perm(r.tenant_id, 'academics') or (r.tenant_id = my_tenant() and is_staff())
             or (r.published_at is not null and r.student_id in (select my_students()))))
    when 'fee_invoice' then exists (
      select 1 from fee_invoices i where i.id = p_id
        and (has_perm(i.tenant_id, 'fees') or (i.tenant_id = my_tenant() and i.student_id in (select my_students()))))
    when 'payment_receipt' then exists (
      select 1 from payments p join fee_invoices i on i.id = p.invoice_id
       where p.id = p_id and p.status = 'success'
         and (has_perm(i.tenant_id, 'fees') or (i.tenant_id = my_tenant() and i.student_id in (select my_students()))))
    else false
  end
$$;

create or replace function may_sign_unasked(p_kind text, p_id uuid, p_capacity text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_kind = 'report_card' and p_capacity = 'principal' then exists (
      select 1 from report_cards r where r.id = p_id and may_administer(r.tenant_id))
    when p_kind = 'report_card' and p_capacity = 'class_teacher' then exists (
      select 1 from report_cards r join classes c on c.id = r.class_id
       where r.id = p_id and r.tenant_id = my_tenant() and c.class_teacher_id = auth.uid())
    when p_kind = 'fee_invoice' and p_capacity = 'bursar' then exists (
      select 1 from fee_invoices i where i.id = p_id and has_perm(i.tenant_id, 'fees'))
    when p_kind = 'payment_receipt' and p_capacity = 'bursar' then exists (
      select 1 from payments p where p.id = p_id and p.status = 'success' and has_perm(p.tenant_id, 'fees'))
    when p_kind = 'student_document' and p_capacity = 'staff' then exists (
      select 1 from student_documents d where d.id = p_id and (has_perm(d.tenant_id, 'people') or (d.tenant_id = my_tenant() and is_staff())))
    else false
  end
$$;

-- ---------------------------------------------------------------- transport

create or replace function assign_learner_bus(p_student_id uuid, p_route_id uuid, p_stop_id uuid DEFAULT NULL::uuid, p_new_stop jsonb DEFAULT NULL::jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_route_tenant uuid;
  v_stop   uuid := p_stop_id;
  v_pos    int;
  v_count  int;
  v_name   text;
  v_lat    double precision;
  v_lng    double precision;
begin
  select tenant_id into v_tenant from students where id = p_student_id;
  if v_tenant is null or not has_perm(v_tenant, 'transport') then
    raise exception 'You can only set the bus of a learner at a school you administer' using errcode = '42501';
  end if;

  if p_route_id is null then
    delete from student_transport where student_id = p_student_id;
    return null;
  end if;

  select tenant_id into v_route_tenant from routes where id = p_route_id for update;
  if v_route_tenant is distinct from v_tenant then
    raise exception 'That route is not at this learner''s school' using errcode = '42501';
  end if;

  if p_new_stop is not null then
    v_name := nullif(left(trim(coalesce(p_new_stop->>'name', '')), 120), '');
    v_lat := (p_new_stop->>'lat')::double precision;
    v_lng := (p_new_stop->>'lng')::double precision;
    if v_name is null or v_lat is null or v_lng is null
       or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'A new stop needs a name and a place on the map' using errcode = '22023';
    end if;
    select count(*) into v_count from route_stops where route_id = p_route_id;
    v_pos := greatest(1, least(coalesce((p_new_stop->>'position')::int, v_count + 1), v_count + 1));
    -- make room: the stops from v_pos on move down one, via negative sequences
    update route_stops set sequence = -sequence where route_id = p_route_id and sequence >= v_pos;
    update route_stops set sequence = -sequence + 1 where route_id = p_route_id and sequence < 0;
    insert into route_stops (tenant_id, route_id, name, lat, lng, sequence)
    values (v_tenant, p_route_id, v_name, v_lat, v_lng, v_pos)
    returning id into v_stop;
  elsif v_stop is not null and not exists (select 1 from route_stops where id = v_stop and route_id = p_route_id) then
    raise exception 'That stop is not on this route' using errcode = '22023';
  end if;

  insert into student_transport (tenant_id, student_id, route_id, stop_id)
  values (v_tenant, p_student_id, p_route_id, v_stop)
  on conflict (student_id) do update set route_id = excluded.route_id, stop_id = excluded.stop_id, tenant_id = excluded.tenant_id;
  return v_stop;
end;
$$;

create or replace function guard_vehicle_driver_columns() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or has_perm(old.tenant_id, 'transport') then return new; end if;

  if (to_jsonb(new) - 'last_lat' - 'last_lng' - 'last_ping_at')
     is distinct from (to_jsonb(old) - 'last_lat' - 'last_lng' - 'last_ping_at') then
    raise exception 'A driver can only update the vehicle''s position.' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function save_route_stops(p_route_id uuid, p_stops jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_el     jsonb;
  v_i      bigint;
  v_id     uuid;
  v_name   text;
  v_lat    double precision;
  v_lng    double precision;
begin
  select tenant_id into v_tenant from routes where id = p_route_id for update;
  if v_tenant is null or not has_perm(v_tenant, 'transport') then
    raise exception 'You can only change the stops of a route at a school you administer' using errcode = '42501';
  end if;
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception 'Stops must be a list' using errcode = '22023';
  end if;

  delete from route_stops
  where route_id = p_route_id
    and id not in (
      select (e->>'id')::uuid from jsonb_array_elements(p_stops) e where coalesce(e->>'id', '') <> ''
    );

  update route_stops set sequence = -sequence where route_id = p_route_id and sequence > 0;

  for v_el, v_i in select e, n from jsonb_array_elements(p_stops) with ordinality as t(e, n) loop
    v_name := nullif(left(trim(coalesce(v_el->>'name', '')), 120), '');
    v_lat := (v_el->>'lat')::double precision;
    v_lng := (v_el->>'lng')::double precision;
    if v_name is null or v_lat is null or v_lng is null
       or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'Stop % needs a name and a place on the map', v_i using errcode = '22023';
    end if;
    v_id := nullif(v_el->>'id', '')::uuid;
    if v_id is not null and exists (select 1 from route_stops where id = v_id and route_id = p_route_id) then
      update route_stops set name = v_name, lat = v_lat, lng = v_lng, sequence = v_i where id = v_id;
    else
      insert into route_stops (tenant_id, route_id, name, lat, lng, sequence)
      values (v_tenant, p_route_id, v_name, v_lat, v_lng, v_i);
    end if;
  end loop;
end;
$$;

create or replace function trip_rider_list(p_trip_id uuid) returns TABLE(student_id uuid, full_name text, stop_id uuid, status text, boarded_at timestamp with time zone, alighted_at timestamp with time zone, absent_from_class boolean)
language sql stable security definer set search_path = public as $$
  with trip as (
    select t.* from trips t
    where t.id = p_trip_id
      and (t.driver_id = auth.uid() or (t.tenant_id = my_tenant() and is_staff()) or has_perm(t.tenant_id, 'transport'))
  ),
  riders as (
    select r.student_id, r.stop_id, r.status, r.boarded_at, r.alighted_at
    from trip_riders r join trip on r.trip_id = trip.id
    union all
    -- on the route, but added after the trip started: expected, with no row yet
    select st.student_id, st.stop_id, 'expected', null::timestamptz, null::timestamptz
    from student_transport st join trip on st.route_id = trip.route_id
    join students s on s.id = st.student_id and s.active and s.tenant_id = trip.tenant_id
    where not exists (select 1 from trip_riders r where r.trip_id = trip.id and r.student_id = st.student_id)
  )
  select x.student_id, s.full_name, x.stop_id, x.status, x.boarded_at, x.alighted_at,
    trip.direction = 'from_school'
      and absent_from_class(x.student_id, (trip.started_at at time zone 'Africa/Nairobi')::date)
  from riders x
  cross join trip
  join students s on s.id = x.student_id
  order by s.full_name
$$;
