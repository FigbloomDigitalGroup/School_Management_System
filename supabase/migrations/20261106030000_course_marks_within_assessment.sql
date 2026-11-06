-- FIG-1377: a higher-education mark cannot be above its assessment's total.
--
-- A school exam mark is checked against its paper by a trigger (marks_within_paper: "score 101 exceeds the paper total"). course_marks had
-- no such rule. Its only check was score >= 0, and the column is numeric(6,2), so the database held anything up to 9999.99 whatever
-- course_assessments.out_of was. The gradebook screen refuses a mark above out_of (GpaGradebook.tsx), so the rule existed only there, and
-- weightedScore does not cap: 125 of 100 at a weight of 40% adds 50 points, so a mark above the total raised the weighted score, and the
-- grade, above what the work can earn.
--
-- Two triggers close it, in words, with the same code as the other table rules (23514):
--   course_marks:       a score above the assessment's total is refused on insert, on an edit of the score, and when a mark is moved to
--                       another assessment (it has to fit the new one).
--   course_assessments: the total cannot be lowered below a mark the assessment already has, which would leave the same thing in the table
--                       by the other door.
-- A blank score (not marked yet) is fine, and so is a mark equal to the total. Marks already in the table are not touched.
--
-- Both are SECURITY DEFINER with a fixed search_path so the answer does not depend on which rows the caller's row-level security lets
-- them see: a lookup that came back empty would let a too-high mark through.

create or replace function course_marks_within_assessment() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  total int;
begin
  if new.score is not null then
    select out_of into total from course_assessments where id = new.assessment_id;
    if total is not null and new.score > total then
      raise exception 'score % exceeds the assessment total of %', new.score, total using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger course_marks_within_assessment
  before insert or update of score, assessment_id on course_marks
  for each row execute function course_marks_within_assessment();

create or replace function course_assessments_total_covers_marks() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  above bigint;
begin
  select count(*) into above from course_marks where assessment_id = new.id and score > new.out_of;
  if above > 0 then
    raise exception '% % of % % above %, so the total cannot be lowered to % (the highest mark is %).',
      above, case when above = 1 then 'mark' else 'marks' end, new.name, case when above = 1 then 'is' else 'are' end, new.out_of, new.out_of,
      (select max(score) from course_marks where assessment_id = new.id)
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger course_assessments_total_covers_marks
  before update of out_of on course_assessments
  for each row
  when (new.out_of < old.out_of)
  execute function course_assessments_total_covers_marks();
