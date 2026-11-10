-- FIG-1389: a report card that has gone out to families can no longer be rewritten in place, and a changed comment is on the record.
--
-- The migration that made report_cards says "a family downloads exactly what the school issued", and the Report cards screen keeps to it
-- (saveReportCards leaves a card that has gone out alone: "withdraw it first to re-prepare it"). That rule lived only in the browser. The write
-- policy let the office update any column of a card whose published_at is set, and the only trigger, report_cards_audit_publish, writes an
-- entry only when published_at changes between null and not null. So through the API the office could change `data` (the marks, the mean, the
-- grade) of a card the family already held, with no withdrawal and nothing in audit_events. (A signed card showed it, because a signature is
-- tied to a fingerprint of the card; an unsigned card showed nothing.)
--
-- Two triggers, because the office may still correct a comment on a card that has gone out (the Comments button works on a sent card, and a
-- test says so) but nothing legitimate rewrites its figures:
--
--   report_cards_sent_stay_as_issued    before update of data: refused (23514) while the card is out before and after the statement. A
--                                       withdrawal sets published_at to null, which is logged by report_cards_audit_publish, and after
--                                       that the card is a draft again: so withdrawing first, or withdrawing and rewriting in one
--                                       statement, still works, and either way the withdrawal is on the record.
--   report_cards_audit_sent_comment     after update of the comments: one audit entry, "Comment changed on the report card already sent for
--                                       <learner>", naming which comment changed (not the words: they can be about a child), by whom and
--                                       when (the entry's own actor and time). Saving the same text again changes nothing and logs nothing,
--                                       and a draft's comments are the office's own work and are not logged.

create or replace function report_cards_sent_stay_as_issued() returns trigger
language plpgsql
as $$
begin
  if old.published_at is not null and new.published_at is not null and new.data is distinct from old.data then
    raise exception 'This report card has gone out to the family, so its marks and figures cannot be changed. Withdraw it first, then prepare it again and send it.'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger report_cards_sent_stay_as_issued
  before update of data on report_cards
  for each row execute function report_cards_sent_stay_as_issued();

create or replace function report_cards_audit_sent_comment() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed jsonb := '[]'::jsonb;
begin
  if new.teacher_comment is distinct from old.teacher_comment then changed := changed || '"teacher_comment"'::jsonb; end if;
  if new.principal_comment is distinct from old.principal_comment then changed := changed || '"principal_comment"'::jsonb; end if;
  if jsonb_array_length(changed) = 0 then
    return new;
  end if;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (new.tenant_id, auth.uid(), my_actor_label(),
          format('Comment changed on the report card already sent for %s', coalesce(new.data #>> '{learner,name}', 'a learner')),
          'academic',
          jsonb_build_object('report_card_id', new.id, 'term_id', new.term_id, 'student_id', new.student_id, 'changed', changed));
  return new;
end $$;

create trigger report_cards_audit_sent_comment
  after update of teacher_comment, principal_comment on report_cards
  for each row
  when (old.published_at is not null and new.published_at is not null)
  execute function report_cards_audit_sent_comment();
