-- FIG-1375: the server publishes a class's marks only when every learner of the class has an entry.
--
-- publish_marks(exam, class, subject) checked that the caller teaches the subject and that there was at least one mark row. It never
-- compared the rows with the learners of the class: "N still to enter" was a rule of the gradebook screens, not of the server. Marks for
-- two learners of a whole class, then publish_marks from a script, a changed app, or the screen bug of FIG-1374, was accepted, and
-- class_means_for_exam then showed parents a "class mean" worked out from a handful of learners (84.5, shown as 85, from two marks).
--
-- It now also refuses while any ACTIVE learner of the class has no row for this exam and subject, in words, with the same code (22023)
-- as the "no marks yet" refusal. A missed or excused paper is a row with no score and an absence, so "no entry" can be told from "absent":
-- recording a learner as absent counts as an entry, an empty box does not. Learners who have left the class or been archived are not
-- counted. Everything else in the function is as it was.

create or replace function publish_marks(p_exam_id uuid, p_class_id uuid, p_subject_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ex exams; cls classes; subj subjects; n bigint; missing bigint;
begin
  select * into ex from exams where id = p_exam_id;
  select * into cls from classes where id = p_class_id;
  select * into subj from subjects where id = p_subject_id;
  if ex.id is null or cls.id is null or subj.id is null
     or cls.tenant_id <> ex.tenant_id or subj.tenant_id <> ex.tenant_id then
    raise exception 'That exam, class or subject could not be found.' using errcode = '42501';
  end if;
  if not may_teach_class_subject(ex.tenant_id, p_class_id, p_subject_id) then
    raise exception 'You don''t teach % to %.', subj.name, cls.name using errcode = '42501';
  end if;

  select count(*) into n
    from marks m join students s on s.id = m.student_id
   where m.exam_id = p_exam_id and m.subject_id = p_subject_id and s.class_id = p_class_id;
  if n = 0 then
    raise exception 'There are no marks to publish yet.' using errcode = '22023';
  end if;

  select count(*) into missing
    from students s
   where s.class_id = p_class_id and s.active
     and not exists (select 1 from marks m where m.exam_id = p_exam_id and m.subject_id = p_subject_id and m.student_id = s.id);
  if missing > 0 then
    raise exception '% % in % % no entry for % yet. Enter a mark for each, or "abs" for a paper they missed, before publishing.',
      missing, case when missing = 1 then 'learner' else 'learners' end, cls.name,
      case when missing = 1 then 'has' else 'have' end, subj.name using errcode = '22023';
  end if;

  insert into mark_publications (exam_id, class_id, subject_id, tenant_id, published_by)
  values (p_exam_id, p_class_id, p_subject_id, ex.tenant_id, auth.uid())
  on conflict (exam_id, class_id, subject_id) do nothing;

  if found then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (ex.tenant_id, auth.uid(), my_actor_label(),
            format('%s %s results published for %s', subj.name, ex.name, cls.name), 'academic',
            jsonb_build_object('exam_id', ex.id, 'class_id', cls.id, 'subject_id', subj.id, 'marks', n));
  end if;
end $$;
