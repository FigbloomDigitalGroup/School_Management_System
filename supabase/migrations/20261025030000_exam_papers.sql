-- Exam papers and assessments that learners read or sit online.
--
-- `exams` (20260901000000) is only a named marks event per term ("End of
-- term 2", out of 100) that teachers type marks into. This adds the paper
-- itself: something a teacher posts for one class and subject, which
-- learners either just read (a PDF or typed paper, written on paper in the
-- exam room) or sit online (timed questions, choice questions marked
-- automatically, written answers marked by the teacher).
--
--   exam_papers         the paper: kind (an exam, or a CAT/quiz/test, the
--                       same engine either way), class + subject, read or
--                       online, the window it is open, and an optional link
--                       to a term exam so its scores can go into the
--                       Gradebook.
--   exam_paper_texts    a read-mode paper typed in rather than uploaded.
--                       Kept apart from exam_papers so families can see an
--                       upcoming paper's title and date without its content.
--   exam_questions      online questions: choice, short or long answer.
--   exam_question_keys  the right option / model answer. Staff who teach the
--                       class and subject only: learners never read it.
--   exam_attempts       one learner's sitting of one paper. Nobody writes
--                       here directly; the RPCs at the bottom do, so the
--                       time limit and the marking can't be got around.
--
-- Files: <tenant>/exam-papers/<paper_id>/<file> in private-documents. Staff
-- already write anywhere in their school (private_docs_staff_write); the
-- read policy below lets a family reach a paper's file once it has opened.

-- ---------------------------------------------------------------- tables
create table exam_papers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants on delete cascade,
  kind                text not null default 'exam' check (kind in ('exam', 'assessment')),
  title               text not null check (length(trim(title)) between 1 and 160),
  instructions        text not null default '' check (length(instructions) <= 4000),
  class_id            uuid not null references classes on delete cascade,
  subject_id          uuid not null references subjects on delete cascade,
  -- the term exam this counts towards; its scores can be sent to `marks`
  exam_id             uuid references exams on delete set null,
  mode                text not null default 'online' check (mode in ('read', 'online')),
  -- read mode: the paper itself; online mode: optional reference material
  file_path           text,
  file_name           text,
  opens_at            timestamptz not null default now(),
  closes_at           timestamptz,
  duration_minutes    int check (duration_minutes between 1 and 600),
  published_at        timestamptz,
  results_released_at timestamptz,
  created_by          uuid references profiles on delete set null default auth.uid(),
  created_at          timestamptz not null default now(),
  check (closes_at is null or closes_at > opens_at),
  check (mode = 'online' or duration_minutes is null),
  check ((file_path is null) = (file_name is null))
);
create index on exam_papers (tenant_id, class_id);
create index on exam_papers (exam_id);

create table exam_paper_texts (
  paper_id uuid primary key references exam_papers on delete cascade,
  body     text not null check (length(body) <= 50000)
);

create table exam_questions (
  id       uuid primary key default gen_random_uuid(),
  paper_id uuid not null references exam_papers on delete cascade,
  position int  not null,
  kind     text not null check (kind in ('choice', 'short', 'long')),
  prompt   text not null check (length(trim(prompt)) between 1 and 4000),
  -- choice only: the options as an array of strings, 2 to 8 of them
  options  jsonb,
  points   int  not null default 1 check (points between 1 and 100),
  unique (paper_id, position),
  check (
    (kind = 'choice' and jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 8)
    or (kind <> 'choice' and options is null)
  )
);

create table exam_question_keys (
  question_id    uuid primary key references exam_questions on delete cascade,
  -- choice: index into exam_questions.options (0-based)
  correct_option int check (correct_option >= 0),
  -- written: what a good answer looks like, for whoever marks it
  model_answer   text check (length(model_answer) <= 4000)
);

create table exam_attempts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants on delete cascade,
  paper_id       uuid not null references exam_papers on delete cascade,
  student_id     uuid not null references students on delete cascade,
  started_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  -- { "<question id>": 2 } for a choice (option index), { "<question id>": "text" } for a written answer
  answers        jsonb not null default '{}',
  -- { "<question id>": points awarded }; choice questions filled in on submit
  question_marks jsonb not null default '{}',
  -- { "<question id>": "a note from the teacher" }
  question_notes jsonb not null default '{}',
  auto_score     int,
  -- null until every question has a mark
  final_score    int,
  marked_by      uuid references profiles on delete set null,
  marked_at      timestamptz,
  feedback       text check (length(feedback) <= 4000),
  unique (paper_id, student_id)
);
create index on exam_attempts (tenant_id, student_id);

-- ---------------------------------------------------------------- who may do what
-- Security definer so the policies below don't depend on the read policies of
-- the tables they look at.

-- Staff who teach this paper's class and subject, or run the school.
create or replace function may_edit_exam_paper(p_paper_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select may_teach_class_subject(p.tenant_id, p.class_id, p.subject_id)
      from exam_papers p where p.id = p_paper_id
  ), false)
$$;

-- The classes of the learners this user is (a student) or looks after (a parent).
create or replace function my_family_class_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.class_id from students s
   where s.tenant_id = my_tenant()
     and (s.profile_id = auth.uid()
          or exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid()))
$$;

-- The paper's content (typed text, uploaded file): any staff member in the
-- school; a family once the paper is published and has opened.
create or replace function exam_paper_open_to_me(p_paper_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from exam_papers p
     where p.id = p_paper_id
       and (
         is_super() or may_administer(p.tenant_id)
         or (p.tenant_id = my_tenant() and is_staff())
         or (p.tenant_id = my_tenant() and p.published_at is not null and p.opens_at <= now()
             and p.class_id in (select my_family_class_ids()))
       )
  )
$$;

-- Online questions: staff in the school; a learner only once they've started
-- (so the clock is already running when they first see them); a family once
-- results are out. A parent's login can't be used to preview the paper.
create or replace function may_read_exam_questions(p_paper_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from exam_papers p
     where p.id = p_paper_id
       and (
         is_super() or may_administer(p.tenant_id)
         or (p.tenant_id = my_tenant() and is_staff())
         or (p.tenant_id = my_tenant() and p.published_at is not null and (
               exists (select 1 from exam_attempts a join students s on s.id = a.student_id
                        where a.paper_id = p.id and s.profile_id = auth.uid())
               or (p.results_released_at is not null and p.class_id in (select my_family_class_ids()))
             ))
       )
  )
$$;

create or replace function exam_results_released(p_paper_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from exam_papers where id = p_paper_id and results_released_at is not null)
$$;

revoke execute on function may_edit_exam_paper(uuid) from public, anon;
revoke execute on function my_family_class_ids() from public, anon;
revoke execute on function exam_paper_open_to_me(uuid) from public, anon;
revoke execute on function may_read_exam_questions(uuid) from public, anon;
revoke execute on function exam_results_released(uuid) from public, anon;
grant execute on function may_edit_exam_paper(uuid) to authenticated;
grant execute on function my_family_class_ids() to authenticated;
grant execute on function exam_paper_open_to_me(uuid) to authenticated;
grant execute on function may_read_exam_questions(uuid) to authenticated;
grant execute on function exam_results_released(uuid) to authenticated;

-- ---------------------------------------------------------------- row-level security
alter table exam_papers enable row level security;
alter table exam_paper_texts enable row level security;
alter table exam_questions enable row level security;
alter table exam_question_keys enable row level security;
alter table exam_attempts enable row level security;

-- A family sees a published paper for their child's class (title, dates,
-- instructions) before it opens, so they know it's coming.
create policy exam_papers_read on exam_papers for select
  using (
    is_super() or may_administer(tenant_id)
    or (tenant_id = my_tenant() and (
          is_staff()
          or (published_at is not null and class_id in (select my_family_class_ids()))
        ))
  );
create policy exam_papers_write on exam_papers for all
  using (may_teach_class_subject(tenant_id, class_id, subject_id))
  with check (may_teach_class_subject(tenant_id, class_id, subject_id));

create policy exam_paper_texts_read on exam_paper_texts for select
  using (exam_paper_open_to_me(paper_id));
create policy exam_paper_texts_write on exam_paper_texts for all
  using (may_edit_exam_paper(paper_id)) with check (may_edit_exam_paper(paper_id));

create policy exam_questions_read on exam_questions for select
  using (may_read_exam_questions(paper_id));
create policy exam_questions_write on exam_questions for all
  using (may_edit_exam_paper(paper_id)) with check (may_edit_exam_paper(paper_id));

create policy exam_question_keys_all on exam_question_keys for all
  using (exists (select 1 from exam_questions q where q.id = question_id and may_edit_exam_paper(q.paper_id)))
  with check (exists (select 1 from exam_questions q where q.id = question_id and may_edit_exam_paper(q.paper_id)));

-- A learner's own row before results are out comes from my_exam_attempts(),
-- which leaves the marks off: a score showing while the paper is still open
-- would tell the class which answers were right.
create policy exam_attempts_read on exam_attempts for select
  using (
    is_super() or may_administer(tenant_id)
    or (tenant_id = my_tenant() and is_staff() and may_edit_exam_paper(paper_id))
    or (student_id in (select my_students()) and exam_results_released(paper_id))
  );
revoke insert, update, delete on exam_attempts from anon, authenticated;

-- ---------------------------------------------------------------- storage
create or replace function exam_paper_file_open_to_me(p_paper_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from exam_papers p where p.id::text = p_paper_id and exam_paper_open_to_me(p.id))
$$;
revoke execute on function exam_paper_file_open_to_me(text) from public, anon;
grant execute on function exam_paper_file_open_to_me(text) to authenticated;

-- Separate from private_docs_read (policies are OR-ed): <tenant>/exam-papers/<paper_id>/<file>.
create policy private_docs_exam_papers_read on storage.objects for select
  using (
    bucket_id = 'private-documents'
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'exam-papers'
    and exam_paper_file_open_to_me((storage.foldername(name))[3])
  );

-- ---------------------------------------------------------------- consistency guards
-- The class, subject and term exam must all belong to the paper's school.
create or replace function exam_papers_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from classes where id = new.class_id and tenant_id = new.tenant_id)
     or not exists (select 1 from subjects where id = new.subject_id and tenant_id = new.tenant_id)
     or (new.exam_id is not null and not exists (select 1 from exams where id = new.exam_id and tenant_id = new.tenant_id)) then
    raise exception 'That class, subject or exam belongs to another school.' using errcode = '42501';
  end if;
  -- Releasing shows scripts to families, so it goes through
  -- release_exam_results(), which refuses while anything is unmarked.
  if new.results_released_at is distinct from (case when tg_op = 'UPDATE' then old.results_released_at end)
     and coalesce(current_setting('figbloom.exam_release', true), '') <> 'on' then
    raise exception 'Release results from the scripts page.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and exists (select 1 from exam_attempts where paper_id = old.id) then
    if new.class_id <> old.class_id or new.subject_id <> old.subject_id or new.mode <> old.mode then
      raise exception 'Learners have already started this paper, so its class, subject and type can''t change.' using errcode = '23001';
    end if;
    if new.published_at is null then
      raise exception 'Learners have already started this paper, so it can''t be unpublished.' using errcode = '23001';
    end if;
  end if;
  return new;
end $$;
create trigger exam_papers_consistent before insert or update on exam_papers
  for each row execute function exam_papers_consistent();

-- A paper learners have sat can't be deleted by hand: their answers would go
-- with it. (pg_trigger_depth() = 1 is a direct DELETE; a class or school
-- being removed cascades at a deeper level and must still work.)
create or replace function guard_exam_paper_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  if pg_trigger_depth() = 1 and exists (select 1 from exam_attempts where paper_id = old.id) then
    raise exception 'Learners have already sat "%", so it can''t be deleted.', old.title using errcode = '23001';
  end if;
  return old;
end $$;
create trigger exam_papers_guard_delete before delete on exam_papers
  for each row execute function guard_exam_paper_delete();

-- Once anyone has started, the questions are fixed: adding, removing or
-- re-scoring one would change the paper under them. Fixing a typo in a
-- prompt is still fine.
create or replace function guard_exam_question_change() returns trigger
language plpgsql set search_path = public as $$
declare
  pid uuid := coalesce(new.paper_id, old.paper_id);
begin
  if pg_trigger_depth() = 1 and exists (select 1 from exam_attempts where paper_id = pid) then
    if tg_op <> 'UPDATE' then
      raise exception 'Learners have already started this paper, so its questions can''t change.' using errcode = '23001';
    elsif new.kind <> old.kind or new.points <> old.points or new.options is distinct from old.options
          or new.position <> old.position or new.paper_id <> old.paper_id then
      raise exception 'Learners have already started this paper, so its questions can''t change.' using errcode = '23001';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger exam_questions_guard before insert or update or delete on exam_questions
  for each row execute function guard_exam_question_change();

-- ---------------------------------------------------------------- marking internals
-- Not callable by anyone: only the RPCs below use these.

-- When an attempt has to be in. Null = no limit.
create or replace function exam_attempt_deadline(p_started timestamptz, p_duration int, p_closes timestamptz)
returns timestamptz
language sql immutable as $$
  select case
    when p_duration is null then p_closes
    when p_closes is null then p_started + make_interval(mins => p_duration)
    else least(p_started + make_interval(mins => p_duration), p_closes)
  end
$$;

-- Keeps only answers to this paper's questions, in the right shape.
create or replace function exam_clean_answers(p_paper_id uuid, p_answers jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  q record; v jsonb; result jsonb := '{}';
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then return result; end if;
  for q in select id, kind, options from exam_questions where paper_id = p_paper_id loop
    v := p_answers -> q.id::text;
    continue when v is null;
    if q.kind = 'choice' then
      if jsonb_typeof(v) = 'number' and v::text ~ '^\d{1,2}$' and v::text::int < jsonb_array_length(q.options) then
        result := result || jsonb_build_object(q.id::text, v::text::int);
      end if;
    elsif jsonb_typeof(v) = 'string' and length(btrim(v #>> '{}')) > 0 then
      result := result || jsonb_build_object(q.id::text, left(v #>> '{}', 20000));
    end if;
  end loop;
  return result;
end $$;

-- Recomputes the marks the system can give itself (choice questions with a
-- key; blank written answers score 0) and the totals. Marks a teacher has
-- given written answers are kept.
create or replace function exam_auto_mark(p_attempt_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  a exam_attempts; q record; m jsonb; auto int := 0; total int := 0; complete boolean := true; given jsonb;
begin
  select * into a from exam_attempts where id = p_attempt_id for update;
  if a.id is null or a.submitted_at is null then return; end if;
  m := a.question_marks;
  for q in
    select eq.id, eq.kind, eq.points, k.correct_option
      from exam_questions eq left join exam_question_keys k on k.question_id = eq.id
     where eq.paper_id = a.paper_id
  loop
    if q.kind = 'choice' and q.correct_option is not null then
      m := m || jsonb_build_object(q.id::text,
             case when (a.answers -> q.id::text) = to_jsonb(q.correct_option) then q.points else 0 end);
      auto := auto + (m ->> q.id::text)::int;
    elsif not (a.answers ? q.id::text) then
      m := m || jsonb_build_object(q.id::text, 0);
    end if;
    given := m -> q.id::text;
    if given is null then complete := false; else total := total + given::text::int; end if;
  end loop;
  update exam_attempts
     set question_marks = m, auto_score = auto, final_score = case when complete then total end
   where id = a.id;
end $$;

-- Submits attempts whose time ran out without the learner pressing Submit
-- (closed the tab, lost power), with whatever was last saved.
create or replace function exam_close_overdue(p_paper_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; a record;
begin
  select * into p from exam_papers where id = p_paper_id;
  for a in
    select id, exam_attempt_deadline(started_at, p.duration_minutes, p.closes_at) as deadline
      from exam_attempts
     where paper_id = p_paper_id and submitted_at is null
  loop
    if a.deadline is not null and now() > a.deadline + interval '2 minutes' then
      update exam_attempts set submitted_at = a.deadline where id = a.id;
      perform exam_auto_mark(a.id);
    end if;
  end loop;
end $$;

-- A corrected key re-marks everyone who has already submitted.
create or replace function exam_key_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  for a in
    select at.id from exam_attempts at join exam_questions q on q.paper_id = at.paper_id
     where q.id = new.question_id and at.submitted_at is not null
  loop
    perform exam_auto_mark(a.id);
  end loop;
  return null;
end $$;
create trigger exam_question_keys_remark after insert or update on exam_question_keys
  for each row execute function exam_key_changed();

-- What a learner's screen needs about their attempt, without any marks.
create or replace function exam_attempt_json(a exam_attempts, p exam_papers) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', a.id,
    'paper_id', a.paper_id,
    'started_at', a.started_at,
    'submitted_at', a.submitted_at,
    'deadline', exam_attempt_deadline(a.started_at, p.duration_minutes, p.closes_at),
    'answers', a.answers,
    'server_now', now()
  )
$$;

revoke execute on function exam_clean_answers(uuid, jsonb) from public, anon, authenticated;
revoke execute on function exam_auto_mark(uuid) from public, anon, authenticated;
revoke execute on function exam_close_overdue(uuid) from public, anon, authenticated;
revoke execute on function exam_attempt_json(exam_attempts, exam_papers) from public, anon, authenticated;

-- ---------------------------------------------------------------- learner RPCs
-- The caller's own active learner record in the paper's class, or an error.
create or replace function exam_my_student_for(p exam_papers) returns students
language plpgsql stable security definer set search_path = public as $$
declare
  st students;
begin
  select * into st from students
   where profile_id = auth.uid() and tenant_id = p.tenant_id and active
   limit 1;
  if p.id is null or p.published_at is null or st.id is null or st.class_id <> p.class_id then
    raise exception 'That paper could not be found.' using errcode = '42501';
  end if;
  if p.mode <> 'online' then
    raise exception 'This paper is read on screen, not sat online.' using errcode = '22023';
  end if;
  return st;
end $$;
revoke execute on function exam_my_student_for(exam_papers) from public, anon, authenticated;

-- Starts the clock (or picks up where the learner left off).
create or replace function start_exam_attempt(p_paper_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; st students; a exam_attempts;
begin
  select * into p from exam_papers where id = p_paper_id;
  st := exam_my_student_for(p);
  select * into a from exam_attempts where paper_id = p.id and student_id = st.id;
  if a.id is null then
    if now() < p.opens_at then
      raise exception 'This paper hasn''t opened yet.' using errcode = '22023';
    end if;
    if p.closes_at is not null and now() >= p.closes_at then
      raise exception 'This paper has closed.' using errcode = '22023';
    end if;
    if not exists (select 1 from exam_questions where paper_id = p.id) then
      raise exception 'This paper has no questions yet. Tell your teacher.' using errcode = '22023';
    end if;
    insert into exam_attempts (tenant_id, paper_id, student_id)
    values (p.tenant_id, p.id, st.id)
    returning * into a;
  end if;
  return exam_attempt_json(a, p);
end $$;

-- Autosave, and Submit (p_submit). Answers that arrive after the time limit
-- (plus two minutes for a slow connection) are not taken; the attempt is
-- submitted with what was last saved.
create or replace function save_exam_attempt(p_paper_id uuid, p_answers jsonb, p_submit boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; st students; a exam_attempts; deadline timestamptz; late boolean;
begin
  select * into p from exam_papers where id = p_paper_id;
  st := exam_my_student_for(p);
  select * into a from exam_attempts where paper_id = p.id and student_id = st.id for update;
  if a.id is null then
    raise exception 'Start the paper first.' using errcode = '22023';
  end if;
  if a.submitted_at is not null then
    return exam_attempt_json(a, p) || jsonb_build_object('timed_out', false);
  end if;

  deadline := exam_attempt_deadline(a.started_at, p.duration_minutes, p.closes_at);
  late := deadline is not null and now() > deadline + interval '2 minutes';

  if not late then
    update exam_attempts set answers = exam_clean_answers(p.id, p_answers) where id = a.id;
  end if;
  if p_submit or late then
    update exam_attempts set submitted_at = case when late then deadline else now() end where id = a.id;
    perform exam_auto_mark(a.id);
  end if;

  select * into a from exam_attempts where id = a.id;
  return exam_attempt_json(a, p) || jsonb_build_object('timed_out', late);
end $$;

-- A learner's own attempts, for their Exams list: started / submitted only.
-- Marks come from exam_attempts itself once results are released.
create or replace function my_exam_attempts()
returns table (paper_id uuid, started_at timestamptz, submitted_at timestamptz, deadline timestamptz)
language sql stable security definer set search_path = public as $$
  select a.paper_id, a.started_at, a.submitted_at,
         exam_attempt_deadline(a.started_at, p.duration_minutes, p.closes_at)
    from exam_attempts a
    join exam_papers p on p.id = a.paper_id
    join students s on s.id = a.student_id
   where s.profile_id = auth.uid()
$$;

revoke execute on function start_exam_attempt(uuid) from public, anon;
revoke execute on function save_exam_attempt(uuid, jsonb, boolean) from public, anon;
revoke execute on function my_exam_attempts() from public, anon;
grant execute on function start_exam_attempt(uuid) to authenticated;
grant execute on function save_exam_attempt(uuid, jsonb, boolean) to authenticated;
grant execute on function my_exam_attempts() to authenticated;

-- ---------------------------------------------------------------- staff RPCs
create or replace function exam_paper_for_staff(p_paper_id uuid) returns exam_papers
language plpgsql stable security definer set search_path = public as $$
declare
  p exam_papers;
begin
  select * into p from exam_papers where id = p_paper_id;
  if p.id is null or not may_teach_class_subject(p.tenant_id, p.class_id, p.subject_id) then
    raise exception 'You don''t teach this paper''s class and subject.' using errcode = '42501';
  end if;
  return p;
end $$;
revoke execute on function exam_paper_for_staff(uuid) from public, anon, authenticated;

-- Replaces an online paper's questions and keys in one go, from the builder.
-- p_questions: [{ kind, prompt, options, points, correct_option, model_answer }, ...] in order.
create or replace function replace_exam_questions(p_paper_id uuid, p_questions jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; q jsonb; i int := 0; qid uuid;
begin
  p := exam_paper_for_staff(p_paper_id);
  if exists (select 1 from exam_attempts where paper_id = p.id) then
    raise exception 'Learners have already started this paper, so its questions can''t change.' using errcode = '23001';
  end if;
  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) > 200 then
    raise exception 'A paper can have up to 200 questions.' using errcode = '22023';
  end if;

  delete from exam_questions where paper_id = p.id;
  for q in select value from jsonb_array_elements(p_questions) loop
    i := i + 1;
    insert into exam_questions (paper_id, position, kind, prompt, options, points)
    values (p.id, i, q ->> 'kind', q ->> 'prompt',
            case when q ->> 'kind' = 'choice' then q -> 'options' end,
            coalesce((q ->> 'points')::int, 1))
    returning id into qid;
    if q ->> 'correct_option' is not null or nullif(btrim(q ->> 'model_answer'), '') is not null then
      insert into exam_question_keys (question_id, correct_option, model_answer)
      values (qid,
              case when q ->> 'kind' = 'choice' then (q ->> 'correct_option')::int end,
              nullif(btrim(q ->> 'model_answer'), ''));
    end if;
  end loop;
end $$;

-- Submits anything whose time ran out, so the marking list is complete.
create or replace function close_overdue_exam_attempts(p_paper_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exam_paper_for_staff(p_paper_id);
  perform exam_close_overdue(p_paper_id);
end $$;

-- A teacher's marks and notes for one script. p_marks / p_notes are keyed by
-- question id. Choice questions with a key are the system's to mark.
create or replace function mark_exam_attempt(p_attempt_id uuid, p_marks jsonb, p_notes jsonb, p_feedback text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  a exam_attempts; p exam_papers; q record; m jsonb; n jsonb; v jsonb;
begin
  select * into a from exam_attempts where id = p_attempt_id for update;
  if a.id is null then
    raise exception 'That script could not be found.' using errcode = '42501';
  end if;
  p := exam_paper_for_staff(a.paper_id);
  if a.submitted_at is null then
    raise exception 'This learner hasn''t submitted yet.' using errcode = '22023';
  end if;

  m := a.question_marks;
  n := a.question_notes;
  for q in
    select eq.id, eq.kind, eq.points, k.correct_option
      from exam_questions eq left join exam_question_keys k on k.question_id = eq.id
     where eq.paper_id = a.paper_id
  loop
    v := p_marks -> q.id::text;
    if v is not null and not (q.kind = 'choice' and q.correct_option is not null) then
      if jsonb_typeof(v) = 'null' then
        m := m - q.id::text;
      elsif jsonb_typeof(v) <> 'number' or v::text !~ '^\d{1,3}$' or v::text::int > q.points then
        raise exception 'A mark must be a whole number from 0 to %.', q.points using errcode = '22023';
      else
        m := m || jsonb_build_object(q.id::text, v::text::int);
      end if;
    end if;
    v := p_notes -> q.id::text;
    if v is not null then
      if jsonb_typeof(v) = 'string' and length(btrim(v #>> '{}')) > 0 then
        n := n || jsonb_build_object(q.id::text, left(btrim(v #>> '{}'), 2000));
      else
        n := n - q.id::text;
      end if;
    end if;
  end loop;

  update exam_attempts
     set question_marks = m, question_notes = n,
         feedback = nullif(btrim(coalesce(p_feedback, '')), ''),
         marked_by = auth.uid(), marked_at = now()
   where id = a.id;
  perform exam_auto_mark(a.id);
end $$;

-- Shows learners and their families the scores and feedback (or takes them
-- back). Every submitted script must be fully marked first.
create or replace function release_exam_results(p_paper_id uuid, p_release boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; waiting int;
begin
  p := exam_paper_for_staff(p_paper_id);
  perform set_config('figbloom.exam_release', 'on', true);
  if p_release then
    perform exam_close_overdue(p.id);
    select count(*) into waiting from exam_attempts
     where paper_id = p.id and submitted_at is not null and final_score is null;
    if waiting > 0 then
      raise exception '%', case when waiting = 1 then '1 script still needs marking.'
                                else format('%s scripts still need marking.', waiting) end
        using errcode = '22023';
    end if;
    update exam_papers set results_released_at = coalesce(results_released_at, now()) where id = p.id;
  else
    update exam_papers set results_released_at = null where id = p.id;
  end if;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p.tenant_id, auth.uid(), my_actor_label(),
          format('Results %s for "%s"', case when p_release then 'released' else 'withdrawn' end, p.title), 'academic',
          jsonb_build_object('paper_id', p.id, 'class_id', p.class_id, 'subject_id', p.subject_id));
end $$;

-- Writes each marked script's score into the linked term exam's marks for
-- this subject, scaled to that exam's total. Learners who didn't sit it are
-- left as they are. Refused once those marks are published: withdraw them in
-- the Gradebook first, the same as typing over them would need.
create or replace function send_exam_scores_to_gradebook(p_paper_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; ex exams; total int; n int;
begin
  p := exam_paper_for_staff(p_paper_id);
  if p.exam_id is null then
    raise exception 'Link this paper to a term exam first.' using errcode = '22023';
  end if;
  select * into ex from exams where id = p.exam_id;
  if marks_published(p.exam_id, p.class_id, p.subject_id) then
    raise exception '% marks for this class are already published. Withdraw them in the Gradebook first.', ex.name
      using errcode = '22023';
  end if;
  select coalesce(sum(points), 0) into total from exam_questions where paper_id = p.id;
  if total = 0 then
    raise exception 'This paper has no questions to score.' using errcode = '22023';
  end if;
  if exists (select 1 from exam_attempts where paper_id = p.id and submitted_at is not null and final_score is null) then
    raise exception 'Finish marking every script first.' using errcode = '22023';
  end if;

  insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by)
  select p.tenant_id, p.exam_id, a.student_id, p.subject_id,
         round(a.final_score::numeric * ex.out_of / total)::int, auth.uid()
    from exam_attempts a
    join students s on s.id = a.student_id
   where a.paper_id = p.id and a.final_score is not null
     and s.class_id = p.class_id and s.active
  on conflict (exam_id, student_id, subject_id)
  do update set score = excluded.score, entered_by = excluded.entered_by, entered_at = now();
  get diagnostics n = row_count;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p.tenant_id, auth.uid(), my_actor_label(),
          format('Scores from "%s" sent to %s marks', p.title, ex.name), 'academic',
          jsonb_build_object('paper_id', p.id, 'exam_id', ex.id, 'marks', n));
  return n;
end $$;

revoke execute on function replace_exam_questions(uuid, jsonb) from public, anon;
revoke execute on function close_overdue_exam_attempts(uuid) from public, anon;
revoke execute on function mark_exam_attempt(uuid, jsonb, jsonb, text) from public, anon;
revoke execute on function release_exam_results(uuid, boolean) from public, anon;
revoke execute on function send_exam_scores_to_gradebook(uuid) from public, anon;
grant execute on function replace_exam_questions(uuid, jsonb) to authenticated;
grant execute on function close_overdue_exam_attempts(uuid) to authenticated;
grant execute on function mark_exam_attempt(uuid, jsonb, jsonb, text) to authenticated;
grant execute on function release_exam_results(uuid, boolean) to authenticated;
grant execute on function send_exam_scores_to_gradebook(uuid) to authenticated;
