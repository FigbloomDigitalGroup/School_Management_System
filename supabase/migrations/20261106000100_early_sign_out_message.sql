-- FIG-1513 Stage A, review finding M-A: the refusal message only. The rule is unchanged: a second live sign-out for the same learner
-- on the same school day whose departure time is less than 300 seconds from another live one is refused (errcode 23505), under the same
-- per-learner advisory lock, comparing signed_out_at. A voided sign-out never counts. Only the words changed: the old text said
-- "already signed out a moment ago", which is wrong for a backdated time and never mentioned the five-minute rule.
-- Forward-only: this replaces the function from 20261106000000_early_sign_out.sql (same signature, so its grants stay).

create or replace function record_early_sign_out(
  p_student_id uuid,
  p_reason text,
  p_authorised_by text,
  p_collected_by_name text,
  p_collected_by_relationship text,
  p_collected_by_id_number text,
  p_collected_by_phone text,
  p_note text default null,
  -- an earlier time today as the school's clock reads it ("10:45"); null means now. Combined with today in the school's own time zone
  -- here, so no screen has to know the time zone.
  p_signed_out_time time default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s record;
  v_class text;
  v_tz text;
  v_at timestamptz;
  v_local timestamp;
  v_today date;
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_auth text := btrim(coalesce(p_authorised_by, ''), E' \t\r\n');
  v_name text := btrim(coalesce(p_collected_by_name, ''), E' \t\r\n');
  v_rel text := btrim(coalesce(p_collected_by_relationship, ''), E' \t\r\n');
  v_idn text := btrim(coalesce(p_collected_by_id_number, ''), E' \t\r\n');
  v_phone text := btrim(coalesce(p_collected_by_phone, ''), E' \t\r\n');
  v_note text := nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '');
  v_id uuid;
  v_clash time;
begin
  if auth.uid() is null then
    raise exception 'Sign in to record a sign-out.' using errcode = '42501';
  end if;

  select st.id, st.tenant_id, st.full_name, st.class_id, st.active into s from students st where st.id = p_student_id;
  if not found
     or not (
       has_perm(s.tenant_id, 'attendance')
       or exists (select 1 from classes c where c.id = s.class_id and c.tenant_id = s.tenant_id and c.class_teacher_id = auth.uid())
     ) then
    raise exception 'You can''t record a sign-out for this learner.' using errcode = '42501';
  end if;
  if not s.active then
    raise exception 'This learner is archived.' using errcode = '23514';
  end if;

  -- the same rules as earlySignOutProblem() in packages/shared/src/earlySignOut.ts
  if v_reason = '' or length(v_reason) > 200 then raise exception 'Say why the learner is leaving (up to 200 characters).' using errcode = '23514'; end if;
  if v_auth = '' or length(v_auth) > 120 then raise exception 'Say who authorised the sign-out.' using errcode = '23514'; end if;
  if v_name = '' or length(v_name) > 120 then raise exception 'Enter the name of the person collecting the learner.' using errcode = '23514'; end if;
  if v_rel = '' or length(v_rel) > 60 then raise exception 'Enter how the collector is related to the learner.' using errcode = '23514'; end if;
  if length(v_idn) < 3 or length(v_idn) > 30 then raise exception 'Enter the collector''s ID number.' using errcode = '23514'; end if;
  if v_phone !~ '^\+?[0-9][0-9 ()-]{5,19}$' then raise exception 'Enter the collector''s phone number.' using errcode = '23514'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'The note can be up to 500 characters.' using errcode = '23514'; end if;

  select coalesce(t.timezone, 'Africa/Nairobi') into v_tz from tenants t where t.id = s.tenant_id;
  -- "time out" defaults to now; a person may give an earlier time today, never a later one (a clock a minute ahead is tolerated)
  v_today := (now() at time zone v_tz)::date;
  if p_signed_out_time is null then
    v_at := now();
  else
    v_at := (v_today + p_signed_out_time) at time zone v_tz;
    if v_at > now() + interval '2 minutes' then
      raise exception 'The time out can''t be in the future.' using errcode = '23514';
    end if;
    v_at := least(v_at, now());
  end if;
  v_local := v_at at time zone v_tz;

  -- A learner may leave, come back and leave again, so there is no one-a-day rule. A second sign-out within five minutes of a live
  -- one is a double click. The lock makes two calls for the same learner take turns, so both cannot pass this check together.
  -- (Unchanged from 20261106000000 except that the clashing record's time is now read so the message can name it.)
  perform pg_advisory_xact_lock(hashtextextended(s.id::text, 1));
  select e.signed_out_local into v_clash from early_sign_outs e
   where e.student_id = s.id and e.taken_on = v_today and e.voided_at is null
     and abs(extract(epoch from (e.signed_out_at - v_at))) < 300
   order by abs(extract(epoch from (e.signed_out_at - v_at))), e.signed_out_at
   limit 1;
  if found then
    raise exception '% already has a sign-out recorded at %, within five minutes of this time. If the learner left, came back and left again, enter a time at least five minutes apart.',
      s.full_name, to_char(v_clash, 'HH24:MI') using errcode = '23505';
  end if;

  select c.name into v_class from classes c where c.id = s.class_id;

  insert into early_sign_outs (tenant_id, student_id, class_id, student_name, class_name, taken_on, signed_out_at, signed_out_local,
                               reason, collected_by_name, collected_by_relationship, recorded_by)
  values (s.tenant_id, s.id, s.class_id, s.full_name, v_class, v_today, v_at, date_trunc('second', v_local)::time(0),
          v_reason, v_name, v_rel, auth.uid())
  returning id into v_id;

  insert into early_sign_out_collectors (sign_out_id, tenant_id, id_number, phone, authorised_by, note)
  values (v_id, s.tenant_id, v_idn, v_phone, v_auth, v_note);

  -- No ID number, phone, note or free-text reason in the audit event: the audit log is readable by the audit area, and those are
  -- restricted or private (the log keeps leave reasons out the same way). They stay on the record itself.
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    s.tenant_id, auth.uid(), my_actor_label(),
    format('%s signed out early at %s, collected by %s (%s)', s.full_name, to_char(v_local, 'HH24:MI'), v_name, v_rel),
    'operations',
    jsonb_build_object('sign_out_id', v_id, 'student_id', s.id)
  );
  return v_id;
end $$;
