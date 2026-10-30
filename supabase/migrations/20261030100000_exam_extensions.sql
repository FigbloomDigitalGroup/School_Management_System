-- Per-learner extensions and resits for online papers, and an explicit
-- "missed" and "excused".
--
-- Until now (20261025030000_exam_papers) a paper had one window for the whole
-- class: a learner who was sick, or arrived late, either lost time or lost
-- the paper, and a teacher could only move everyone's window. A learner who
-- never started had no row at all, so nothing said they had missed it, and
-- the Gradebook simply left them out.
--
--   exam_paper_overrides  one learner's own terms on one paper: extra
--                         minutes, a window of their own (opens_at /
--                         closes_at, null = the paper's), how many sittings
--                         they may have (a resit adds one), which sitting
--                         counts when there is more than one, and why. Staff
--                         who may set the paper read it; nobody writes it
--                         directly (set_exam_override / clear_exam_override).
--   exam_paper_excusals   "excused from this paper", with the reason. Neither
--                         missed nor a zero.
--   exam_attempts         now one row per sitting: attempt_no 1, 2, ... The
--                         original stays on the record when a learner resits.
--   marks.absence         'missed' or 'excused' on a mark with no score, so
--                         the Gradebook and results say why there is no mark
--                         instead of showing a blank (or a 0).
--
-- A learner's terms (exam_learner_terms):
--   window   their own opens_at / closes_at where set, else the paper's. They
--            can start inside it, and only inside it.
--   time     the paper's duration plus their extra minutes. Extra minutes also
--            push the closing time back for the deadline, so a learner with 15
--            extra minutes always gets them, even starting late:
--              deadline = min(start + duration + extra, closes_at + extra)
--   sittings attempts_allowed (1 unless a resit was granted). A new sitting
--            can start once the previous one is handed in.
--
-- Which sitting counts (exam_counting_attempt), chosen by the teacher with
-- each resit: 'latest' (the default) is the most recent handed-in sitting;
-- 'best' is the highest final score, the later one on a tie. Sittings not
-- yet handed in never count, so the original stands until a resit is in.
-- Marks, results and the Gradebook all use the counting sitting; the others
-- stay readable by staff (and by the learner once results are out).
--
-- A learner's state on a paper (exam_learner_state), computed on read, never
-- stored: excused, in_progress, submitted (not fully marked), marked, missed
-- (their window has closed and nothing was handed in), or not_started.
-- packages/shared/src/examExtensions.ts learnerPaperStatus() mirrors it:
-- change one, change the other.
--
-- Missed and excused are never a zero. send_exam_scores_to_gradebook writes
-- them as a mark with a null score and an absence, and every mean and chart
-- (class_means_for_exam, the 20261027090000 analytics, report cards,
-- summarise()) already skips a null score.
--
-- Recreated here, each from its latest definition (20261025030000, and
-- 20261026040000 for ai_tutor_blocked), because each reads "the" attempt or
-- its deadline: exam_attempt_json, exam_close_overdue, start_exam_attempt,
-- save_exam_attempt, send_exam_scores_to_gradebook, ai_tutor_blocked. None of
-- them names may_administer; who may set a paper is still
-- exam_paper_for_staff / may_edit_exam_paper, called, not redefined.

-- ---------------------------------------------------------------- tables
create table exam_paper_overrides (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants on delete cascade,
  paper_id         uuid not null references exam_papers on delete cascade,
  student_id       uuid not null references students on delete cascade,
  -- this learner's own window; null = the paper's
  opens_at         timestamptz,
  closes_at        timestamptz,
  extra_minutes    int  not null default 0 check (extra_minutes between 0 and 600),
  -- 1 = the usual single sitting; each resit granted adds one
  attempts_allowed int  not null default 1 check (attempts_allowed between 1 and 10),
  -- which sitting goes on the record when there is more than one
  counting         text not null default 'latest' check (counting in ('latest', 'best')),
  reason           text not null check (length(btrim(reason)) between 1 and 500),
  created_by       uuid references profiles on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (paper_id, student_id),
  check (opens_at is null or closes_at is null or closes_at > opens_at)
);
create index on exam_paper_overrides (tenant_id);

create table exam_paper_excusals (
  paper_id   uuid not null references exam_papers on delete cascade,
  student_id uuid not null references students on delete cascade,
  tenant_id  uuid not null references tenants on delete cascade,
  reason     text not null check (length(btrim(reason)) between 1 and 500),
  created_by uuid references profiles on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (paper_id, student_id)
);
create index on exam_paper_excusals (tenant_id);

-- One row per sitting. The old one-row-per-learner rule is dropped by what it
-- covers rather than by name, so it goes whatever it was called.
alter table exam_attempts add column attempt_no int not null default 1 check (attempt_no between 1 and 10);
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.exam_attempts'::regclass and con.contype = 'u'
       and (select array_agg(att.attname::text order by att.attname) from pg_attribute att
             where att.attrelid = con.conrelid and att.attnum = any (con.conkey)) = array['paper_id', 'student_id']
  loop
    execute format('alter table exam_attempts drop constraint %I', c);
  end loop;
end $$;
alter table exam_attempts add constraint exam_attempts_paper_student_attempt_key unique (paper_id, student_id, attempt_no);

-- Why a mark has no score. Only on a mark with no score: typing a score over
-- it (the learner sat it on paper after all) clears it.
alter table marks add column absence text check (absence in ('missed', 'excused'));
alter table marks add constraint marks_absence_without_score check (absence is null or score is null);

create or replace function marks_score_clears_absence() returns trigger
language plpgsql as $$
begin
  if new.score is not null then new.absence := null; end if;
  return new;
end $$;
create trigger marks_score_clears_absence before insert or update on marks
  for each row execute function marks_score_clears_absence();

-- ---------------------------------------------------------------- row-level security
-- Staff who may set the paper (its teachers, the office) read both, reason
-- and all. Families never read them: a learner's own terms come from
-- learner_exam_states(), which leaves the reason off.
alter table exam_paper_overrides enable row level security;
alter table exam_paper_excusals enable row level security;

create policy exam_paper_overrides_read on exam_paper_overrides for select
  using (is_super() or may_edit_exam_paper(paper_id));
create policy exam_paper_excusals_read on exam_paper_excusals for select
  using (is_super() or may_edit_exam_paper(paper_id));
revoke insert, update, delete on exam_paper_overrides from anon, authenticated;
revoke insert, update, delete on exam_paper_excusals from anon, authenticated;

-- ---------------------------------------------------------------- a learner's terms
-- Not callable by anyone: the RPCs below and the functions recreated further
-- down use these.

-- This learner's window, time and sittings on this paper. Always one row.
create or replace function exam_learner_terms(p exam_papers, p_student_id uuid)
returns table (opens_at timestamptz, closes_at timestamptz, duration_minutes int, extra_minutes int, attempts_allowed int, counting text)
language sql stable security definer set search_path = public as $$
  select coalesce(o.opens_at, p.opens_at),
         coalesce(o.closes_at, p.closes_at),
         p.duration_minutes,
         coalesce(o.extra_minutes, 0),
         coalesce(o.attempts_allowed, 1),
         coalesce(o.counting, 'latest')
    from (select 1) one
    left join exam_paper_overrides o on o.paper_id = p.id and o.student_id = p_student_id
$$;

-- exam_attempt_deadline() with this learner's extra minutes on both the time
-- limit and the closing time. Null = no limit.
create or replace function exam_learner_deadline(p_started timestamptz, p_duration int, p_closes timestamptz, p_extra int)
returns timestamptz
language sql immutable as $$
  select exam_attempt_deadline(p_started, p_duration + p_extra, p_closes + make_interval(mins => p_extra))
$$;

-- When this sitting has to be in, the learner's terms included.
create or replace function exam_attempt_deadline_of(a exam_attempts) returns timestamptz
language sql stable security definer set search_path = public as $$
  select exam_learner_deadline(a.started_at, t.duration_minutes, t.closes_at, t.extra_minutes)
    from exam_papers p
    cross join lateral exam_learner_terms(p, a.student_id) t
   where p.id = a.paper_id
$$;

-- The sitting that goes on the record: handed in, then by the learner's rule.
-- Null when nothing has been handed in.
create or replace function exam_counting_attempt(p_paper_id uuid, p_student_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select a.id
    from exam_attempts a
    left join exam_paper_overrides o on o.paper_id = a.paper_id and o.student_id = a.student_id
   where a.paper_id = p_paper_id and a.student_id = p_student_id and a.submitted_at is not null
   order by case when coalesce(o.counting, 'latest') = 'best' then coalesce(a.final_score, -1) end desc nulls last,
            a.attempt_no desc
   limit 1
$$;

-- Where a learner stands on an online paper, right now. Null for a read-mode
-- paper (nothing is sat online, so nothing can be missed).
create or replace function exam_learner_state(p exam_papers, p_student_id uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  t record; counted exam_attempts;
begin
  if p.id is null or p.mode <> 'online' then return null; end if;
  if exists (select 1 from exam_paper_excusals x where x.paper_id = p.id and x.student_id = p_student_id) then
    return 'excused';
  end if;
  if exists (select 1 from exam_attempts a where a.paper_id = p.id and a.student_id = p_student_id and a.submitted_at is null) then
    return 'in_progress';
  end if;
  select * into counted from exam_attempts where id = exam_counting_attempt(p.id, p_student_id);
  if counted.id is not null then
    return case when counted.final_score is null then 'submitted' else 'marked' end;
  end if;
  select * into t from exam_learner_terms(p, p_student_id);
  if t.closes_at is not null and now() >= t.closes_at then
    return 'missed';
  end if;
  return 'not_started';
end $$;

revoke execute on function exam_learner_terms(exam_papers, uuid) from public, anon, authenticated;
revoke execute on function exam_learner_deadline(timestamptz, int, timestamptz, int) from public, anon, authenticated;
revoke execute on function exam_attempt_deadline_of(exam_attempts) from public, anon, authenticated;
revoke execute on function exam_counting_attempt(uuid, uuid) from public, anon, authenticated;
revoke execute on function exam_learner_state(exam_papers, uuid) from public, anon, authenticated;

-- "Does this sitting count?" as a column: PostgREST serves a function on the
-- row type as a computed field, so `select=..., is_counting` works for anyone
-- who can already read the row (row-level security on exam_attempts decides
-- that). Says only yes or no.
create or replace function is_counting(a exam_attempts) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(a.id = exam_counting_attempt(a.paper_id, a.student_id), false)
$$;
revoke execute on function is_counting(exam_attempts) from public, anon;
grant execute on function is_counting(exam_attempts) to authenticated;

-- ---------------------------------------------------------------- recreated: the clock honours the learner's terms
-- From 20261025030000. Only the deadline changes.
create or replace function exam_attempt_json(a exam_attempts, p exam_papers) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', a.id,
    'paper_id', a.paper_id,
    'attempt_no', a.attempt_no,
    'started_at', a.started_at,
    'submitted_at', a.submitted_at,
    'deadline', exam_attempt_deadline_of(a),
    'answers', a.answers,
    'server_now', now()
  )
$$;
revoke execute on function exam_attempt_json(exam_attempts, exam_papers) from public, anon, authenticated;

-- From 20261025030000. Each sitting's own deadline, extensions included.
create or replace function exam_close_overdue(p_paper_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  for a in
    select x.id, exam_attempt_deadline_of(x) as deadline
      from exam_attempts x
     where x.paper_id = p_paper_id and x.submitted_at is null
  loop
    if a.deadline is not null and now() > a.deadline + interval '2 minutes' then
      update exam_attempts set submitted_at = a.deadline where id = a.id;
      perform exam_auto_mark(a.id);
    end if;
  end loop;
end $$;
revoke execute on function exam_close_overdue(uuid) from public, anon, authenticated;

-- From 20261025030000. Starts the clock, picks up the sitting under way, or,
-- with a resit granted and the last sitting handed in, starts the next one.
-- The window is the learner's own where they have one.
create or replace function start_exam_attempt(p_paper_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; st students; a exam_attempts; t record; used int;
begin
  select * into p from exam_papers where id = p_paper_id;
  st := exam_my_student_for(p);
  select * into t from exam_learner_terms(p, st.id);
  select * into a from exam_attempts where paper_id = p.id and student_id = st.id order by attempt_no desc limit 1;
  select count(*) into used from exam_attempts where paper_id = p.id and student_id = st.id;
  if a.id is null or (a.submitted_at is not null and used < t.attempts_allowed) then
    if exists (select 1 from exam_paper_excusals where paper_id = p.id and student_id = st.id) then
      raise exception 'Your teacher has excused you from this paper.' using errcode = '22023';
    end if;
    if now() < t.opens_at then
      raise exception 'This paper hasn''t opened yet.' using errcode = '22023';
    end if;
    if t.closes_at is not null and now() >= t.closes_at then
      raise exception 'This paper has closed.' using errcode = '22023';
    end if;
    if not exists (select 1 from exam_questions where paper_id = p.id) then
      raise exception 'This paper has no questions yet. Tell your teacher.' using errcode = '22023';
    end if;
    insert into exam_attempts (tenant_id, paper_id, student_id, attempt_no)
    values (p.tenant_id, p.id, st.id, coalesce(a.attempt_no, 0) + 1)
    on conflict (paper_id, student_id, attempt_no) do nothing;
    -- a second tab pressing Start at the same moment gets the same sitting
    select * into a from exam_attempts where paper_id = p.id and student_id = st.id order by attempt_no desc limit 1;
  end if;
  return exam_attempt_json(a, p);
end $$;

-- From 20261025030000. Saves into the learner's latest sitting, against its
-- own deadline.
create or replace function save_exam_attempt(p_paper_id uuid, p_answers jsonb, p_submit boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; st students; a exam_attempts; deadline timestamptz; late boolean;
begin
  select * into p from exam_papers where id = p_paper_id;
  st := exam_my_student_for(p);
  select * into a from exam_attempts where paper_id = p.id and student_id = st.id
   order by attempt_no desc limit 1 for update;
  if a.id is null then
    raise exception 'Start the paper first.' using errcode = '22023';
  end if;
  if a.submitted_at is not null then
    return exam_attempt_json(a, p) || jsonb_build_object('timed_out', false);
  end if;

  deadline := exam_attempt_deadline_of(a);
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

revoke execute on function start_exam_attempt(uuid) from public, anon;
revoke execute on function save_exam_attempt(uuid, jsonb, boolean) from public, anon;
grant execute on function start_exam_attempt(uuid) to authenticated;
grant execute on function save_exam_attempt(uuid, jsonb, boolean) to authenticated;

-- From 20261026040000. The study helper stays off for the learner's real
-- deadline (extensions included) and while their own window is open and a
-- sitting is still owed; an excused learner isn't held up by a paper they
-- won't sit.
create or replace function ai_tutor_blocked(p_profile_id uuid) returns text
language sql stable security definer set search_path = public as $$
  with me as (
    select s.id, s.class_id from students s where s.profile_id = p_profile_id and s.active
  )
  select case
    when exists (
      select 1 from exam_attempts a
        join me on me.id = a.student_id
       where a.submitted_at is null
         and coalesce(exam_attempt_deadline_of(a), a.started_at + interval '12 hours')
             + interval '2 minutes' > now())
      then 'You have a paper in progress. The study helper is off until you hand it in.'
    when exists (
      select 1 from exam_papers p
        join me on me.class_id = p.class_id
        cross join lateral exam_learner_terms(p, me.id) t
       where p.kind = 'exam' and p.mode = 'online' and p.published_at is not null
         and t.closes_at is not null and t.opens_at <= now() and t.closes_at > now()
         and not exists (select 1 from exam_paper_excusals x where x.paper_id = p.id and x.student_id = me.id)
         and (select count(*) from exam_attempts a where a.paper_id = p.id and a.student_id = me.id and a.submitted_at is not null)
             < t.attempts_allowed)
      then 'An exam for your class is open. The study helper is off until you have handed it in or it closes.'
  end
$$;
revoke execute on function ai_tutor_blocked(uuid) from public, anon, authenticated;
grant execute on function ai_tutor_blocked(uuid) to service_role;

-- ---------------------------------------------------------------- recreated: the Gradebook gets the counting sitting, and says who missed it
-- From 20261025030000. Each learner's counting sitting only (a resit no
-- longer sends two scores for one learner), then a mark with no score and an
-- absence for each learner in the class who missed the paper or was excused,
-- never a 0. A score already typed for one of them (sat it on paper, say) is
-- left alone. Returns how many learners' marks were written.
create or replace function send_exam_scores_to_gradebook(p_paper_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; ex exams; total int; n int; m int;
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
  perform exam_close_overdue(p.id);
  if exists (select 1 from exam_attempts where paper_id = p.id and submitted_at is not null and final_score is null) then
    raise exception 'Finish marking every script first.' using errcode = '22023';
  end if;

  insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by)
  select p.tenant_id, p.exam_id, a.student_id, p.subject_id,
         round(a.final_score::numeric * ex.out_of / total)::int, auth.uid()
    from exam_attempts a
    join students s on s.id = a.student_id
   where a.paper_id = p.id and a.final_score is not null
     and a.id = exam_counting_attempt(p.id, a.student_id)
     and s.class_id = p.class_id and s.active
  on conflict (exam_id, student_id, subject_id)
  do update set score = excluded.score, entered_by = excluded.entered_by, entered_at = now();
  get diagnostics n = row_count;

  insert into marks (tenant_id, exam_id, student_id, subject_id, score, absence, entered_by)
  select p.tenant_id, p.exam_id, x.id, p.subject_id, null, x.state, auth.uid()
    from (select s.id, exam_learner_state(p, s.id) as state
            from students s
           where s.class_id = p.class_id and s.tenant_id = p.tenant_id and s.active) x
   where x.state in ('missed', 'excused')
  on conflict (exam_id, student_id, subject_id)
  do update set absence = excluded.absence, entered_by = excluded.entered_by, entered_at = now()
   where marks.score is null;
  get diagnostics m = row_count;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p.tenant_id, auth.uid(), my_actor_label(),
          format('Scores from "%s" sent to %s marks', p.title, ex.name), 'academic',
          jsonb_build_object('paper_id', p.id, 'exam_id', ex.id, 'marks', n, 'absences', m));
  return n + m;
end $$;
revoke execute on function send_exam_scores_to_gradebook(uuid) from public, anon;
grant execute on function send_exam_scores_to_gradebook(uuid) to authenticated;

-- ---------------------------------------------------------------- staff RPCs
-- Gives one or more learners their own terms on an online paper: extra
-- minutes, a window of their own (null = the paper's), and/or a resit (one
-- more sitting, for a learner whose last sitting is handed in). Replaces
-- whatever terms they had, except that sittings already allowed are kept.
-- p_counting is which sitting counts once there is more than one. Lifts an
-- excusal: the learner is expected to sit it now. Returns the logins of the
-- learners who have one, so the app can tell them.
create or replace function set_exam_override(
  p_paper_id uuid, p_student_ids uuid[], p_opens_at timestamptz, p_closes_at timestamptz,
  p_extra_minutes int, p_resit boolean, p_counting text, p_reason text
) returns setof uuid
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; sid uuid; st students; o exam_paper_overrides; used int; all_in boolean; allowed int;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_extra int := coalesce(p_extra_minutes, 0);
  v_resit boolean := coalesce(p_resit, false);
  v_counting text := coalesce(p_counting, 'latest');
  v_opens timestamptz; v_closes timestamptz;
begin
  p := exam_paper_for_staff(p_paper_id);
  if p.mode <> 'online' then
    raise exception 'Extra time and resits are for papers sat online.' using errcode = '22023';
  end if;
  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'Pick at least one learner.' using errcode = '22023';
  end if;
  if v_reason = '' or length(v_reason) > 500 then
    raise exception 'Say why in a line, e.g. "Sick on the day".' using errcode = '22023';
  end if;
  if v_extra < 0 or v_extra > 600 then
    raise exception 'Extra time must be 0 to 600 minutes.' using errcode = '22023';
  end if;
  if v_counting not in ('latest', 'best') then
    raise exception 'Pick which sitting counts: the latest or the best.' using errcode = '22023';
  end if;
  v_opens := coalesce(p_opens_at, p.opens_at);
  v_closes := coalesce(p_closes_at, p.closes_at);
  if v_closes is not null and v_closes <= v_opens then
    raise exception 'The window has to close after it opens.' using errcode = '22023';
  end if;

  foreach sid in array p_student_ids loop
    select * into st from students
     where id = sid and tenant_id = p.tenant_id and class_id = p.class_id and active;
    if st.id is null then
      raise exception 'That learner isn''t in this paper''s class.' using errcode = '42501';
    end if;
    select * into o from exam_paper_overrides where paper_id = p.id and student_id = st.id;
    select count(*), coalesce(bool_and(submitted_at is not null), true) into used, all_in
      from exam_attempts where paper_id = p.id and student_id = st.id;

    if not v_resit and v_extra = 0 and p_opens_at is null and p_closes_at is null and coalesce(o.attempts_allowed, 1) <= 1 then
      raise exception 'Give extra time, a window of their own, or a resit.' using errcode = '22023';
    end if;
    if v_resit and (used = 0 or not all_in) then
      raise exception '% hasn''t handed this paper in yet. Give them extra time or their own window instead.', st.full_name
        using errcode = '22023';
    end if;
    if (v_resit or used = 0) and v_closes is not null and v_closes <= now() then
      raise exception 'The paper has closed, so % needs a window of their own to sit it.', st.full_name
        using errcode = '22023';
    end if;
    allowed := case when v_resit then greatest(coalesce(o.attempts_allowed, 1), used) + 1 else coalesce(o.attempts_allowed, 1) end;
    if allowed > 10 then
      raise exception '% has had as many resits as one paper allows.', st.full_name using errcode = '22023';
    end if;

    insert into exam_paper_overrides
      (tenant_id, paper_id, student_id, opens_at, closes_at, extra_minutes, attempts_allowed, counting, reason, created_by)
    values (p.tenant_id, p.id, st.id, p_opens_at, p_closes_at, v_extra, allowed, v_counting, v_reason, auth.uid())
    on conflict (paper_id, student_id) do update
      set opens_at = excluded.opens_at, closes_at = excluded.closes_at, extra_minutes = excluded.extra_minutes,
          attempts_allowed = excluded.attempts_allowed, counting = excluded.counting, reason = excluded.reason,
          created_by = excluded.created_by, updated_at = now();
    delete from exam_paper_excusals where paper_id = p.id and student_id = st.id;

    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (p.tenant_id, auth.uid(), my_actor_label(),
            format('%s for %s on "%s"', case when v_resit then 'Resit' else 'Extension' end, st.full_name, p.title), 'academic',
            jsonb_build_object('paper_id', p.id, 'student_id', st.id, 'extra_minutes', v_extra, 'opens_at', p_opens_at,
                               'closes_at', p_closes_at, 'attempts_allowed', allowed, 'counting', v_counting, 'reason', v_reason));
    if st.profile_id is not null then
      return next st.profile_id;
    end if;
  end loop;
end $$;

-- Takes a learner's own terms away. Refused once they have re-sat: which
-- sitting counts is then on the record.
create or replace function clear_exam_override(p_paper_id uuid, p_student_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; st students; used int;
begin
  p := exam_paper_for_staff(p_paper_id);
  select * into st from students where id = p_student_id and tenant_id = p.tenant_id;
  select count(*) into used from exam_attempts where paper_id = p.id and student_id = p_student_id;
  if used > 1 then
    raise exception '% has already started a resit, so it stays on the record.', st.full_name using errcode = '22023';
  end if;
  delete from exam_paper_overrides where paper_id = p.id and student_id = p_student_id;
  if found then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (p.tenant_id, auth.uid(), my_actor_label(),
            format('Extension removed for %s on "%s"', coalesce(st.full_name, 'a learner'), p.title), 'academic',
            jsonb_build_object('paper_id', p.id, 'student_id', p_student_id));
  end if;
end $$;

-- Excuses a learner from an online paper (neither missed nor a zero), or
-- takes that back. Only before they have started it.
create or replace function set_exam_excusal(p_paper_id uuid, p_student_id uuid, p_excused boolean, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  p exam_papers; st students; v_reason text := btrim(coalesce(p_reason, ''));
begin
  p := exam_paper_for_staff(p_paper_id);
  if p.mode <> 'online' then
    raise exception 'Only papers sat online keep track of who sat them.' using errcode = '22023';
  end if;
  select * into st from students where id = p_student_id and tenant_id = p.tenant_id and class_id = p.class_id;
  if st.id is null then
    raise exception 'That learner isn''t in this paper''s class.' using errcode = '42501';
  end if;
  if p_excused then
    if exists (select 1 from exam_attempts where paper_id = p.id and student_id = st.id) then
      raise exception '% has already started this paper, so they can''t be excused from it.', st.full_name using errcode = '22023';
    end if;
    if v_reason = '' or length(v_reason) > 500 then
      raise exception 'Say why in a line, e.g. "Representing the school at games".' using errcode = '22023';
    end if;
    insert into exam_paper_excusals (paper_id, student_id, tenant_id, reason, created_by)
    values (p.id, st.id, p.tenant_id, v_reason, auth.uid())
    on conflict (paper_id, student_id) do update
      set reason = excluded.reason, created_by = excluded.created_by, created_at = now();
  else
    delete from exam_paper_excusals where paper_id = p.id and student_id = st.id;
  end if;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p.tenant_id, auth.uid(), my_actor_label(),
          format('%s %s on "%s"', case when p_excused then 'Excused' else 'Excusal removed for' end, st.full_name, p.title), 'academic',
          jsonb_build_object('paper_id', p.id, 'student_id', st.id, 'reason', nullif(v_reason, '')));
end $$;

revoke execute on function set_exam_override(uuid, uuid[], timestamptz, timestamptz, int, boolean, text, text) from public, anon;
revoke execute on function clear_exam_override(uuid, uuid) from public, anon;
revoke execute on function set_exam_excusal(uuid, uuid, boolean, text) from public, anon;
grant execute on function set_exam_override(uuid, uuid[], timestamptz, timestamptz, int, boolean, text, text) to authenticated;
grant execute on function clear_exam_override(uuid, uuid) to authenticated;
grant execute on function set_exam_excusal(uuid, uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------- learners and families
-- One learner's standing on every published online paper for their class:
-- their own window and time, their latest sitting, how many sittings they
-- have, and their state. For the learner, their family, and staff
-- (my_students()). The reason for an extension stays with staff. Marks are
-- not here: they come from exam_attempts once results are released.
create or replace function learner_exam_states(p_student_id uuid)
returns table (
  paper_id uuid, opens_at timestamptz, closes_at timestamptz, extra_minutes int,
  attempts_allowed int, attempts_used int, counting text,
  started_at timestamptz, submitted_at timestamptz, deadline timestamptz, state text
)
language sql stable security definer set search_path = public as $$
  select p.id, t.opens_at, t.closes_at, t.extra_minutes, t.attempts_allowed,
         (select count(*)::int from exam_attempts c where c.paper_id = p.id and c.student_id = s.id),
         t.counting,
         l.started_at, l.submitted_at,
         case when l.id is not null then exam_learner_deadline(l.started_at, t.duration_minutes, t.closes_at, t.extra_minutes) end,
         exam_learner_state(p, s.id)
    from students s
    join exam_papers p on p.class_id = s.class_id and p.tenant_id = s.tenant_id
    cross join lateral exam_learner_terms(p, s.id) t
    left join lateral (
      select a.id, a.started_at, a.submitted_at from exam_attempts a
       where a.paper_id = p.id and a.student_id = s.id
       order by a.attempt_no desc limit 1
    ) l on true
   where s.id = p_student_id
     and s.id in (select my_students())
     and p.published_at is not null and p.mode = 'online'
$$;
revoke execute on function learner_exam_states(uuid) from public, anon;
grant execute on function learner_exam_states(uuid) to authenticated;

-- marks.absence is read like any other column, through mark_read, so a family
-- sees "Missed" only once that class and subject is published.
comment on column marks.absence is 'Why a mark has no score: missed (the paper''s window closed with nothing handed in) or excused. Never counted as zero.';
