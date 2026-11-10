-- Report cards that have gone out to families (QA 09, FIG-1389): what the office can still change, and what is recorded.
--
-- "A family downloads exactly what the school issued": once a card is sent, its marks and figures (the `data` column) cannot be rewritten
-- in place, only by withdrawing it first (which is logged); the office may still correct a comment on a sent card, and that is logged too
-- (which comment, who, when). A draft is the office's own work and changes freely.
--
-- Runs against a local database with `npm run db:seed` data, in one transaction that is rolled back (it makes its own throwaway term in 2099
-- and two cards). Every check prints PASS or FAIL. Check the psql exit code too.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/report_cards.sql

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;

-- One statement as the school admin; the answer ('allowed' or 'refused <sqlstate>') is kept in t.r. An action and the read that checks it
-- are separate statements: a read in the same statement would not see what the action changed.
create function pg_temp.act(p_stmt text) returns void language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute p_stmt;
    r := 'allowed';
  exception when others then
    r := 'refused ' || sqlstate;
  end;
  reset role;
  perform set_config('t.r', r, true);
end $$;

create function pg_temp.events(p_card text) returns bigint language sql as $$
  select count(*) from audit_events where metadata->>'report_card_id' = p_card
$$;
create function pg_temp.has_event(p_card text, p_event text) returns boolean language sql as $$
  select coalesce(bool_or(event = p_event), false) from audit_events where metadata->>'report_card_id' = p_card
$$;
create function pg_temp.mean(p_card text) returns text language sql as $$
  select data->'summary'->>'mean' from report_cards where id = p_card::uuid
$$;
create function pg_temp.card_data(p_name text, p_mean int, p_grade text) returns text language sql as $$
  select format('{"learner":{"name":"%s"},"summary":{"mean":%s,"grade":"%s"}}', p_name, p_mean, p_grade)
$$;

select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.cls', (select class_id::text from students where tenant_id = current_setting('t.a')::uuid and active and class_id is not null
                              group by class_id having count(*) >= 2 order by class_id limit 1), true);
create temp table qa_kids as
  select id, row_number() over (order by id) as n from students where class_id = current_setting('t.cls')::uuid and active order by id limit 2;
select set_config('t.sent', '00000000-0000-4000-8000-0000000000c2', true);
select set_config('t.draft', '00000000-0000-4000-8000-0000000000c3', true);

insert into terms (id, tenant_id, name, year, index, starts_on, ends_on)
  values ('00000000-0000-4000-8000-0000000000c1', current_setting('t.a')::uuid, 'QA9 cards term', 2099, 1, '2099-01-05', '2099-04-02');
insert into report_cards (id, tenant_id, term_id, student_id, class_id, data, teacher_comment, principal_comment, published_at) values
  (current_setting('t.sent')::uuid, current_setting('t.a')::uuid, '00000000-0000-4000-8000-0000000000c1', (select id from qa_kids where n = 1), current_setting('t.cls')::uuid,
   pg_temp.card_data('QA9 Sent', 70, 'B+')::jsonb, 'Good.', 'Well done.', now()),
  (current_setting('t.draft')::uuid, current_setting('t.a')::uuid, '00000000-0000-4000-8000-0000000000c1', (select id from qa_kids where n = 2), current_setting('t.cls')::uuid,
   pg_temp.card_data('QA9 Draft', 50, 'C')::jsonb, null, null, null);

-- ---------------------------------------------------------------- a card that has gone out: the marks and figures are fixed
select pg_temp.act(format('update report_cards set data = %L where id = %L', pg_temp.card_data('QA9 Sent', 99, 'A'), current_setting('t.sent')));
select pg_temp.check('the office cannot rewrite the marks and figures of a card that has gone out (mean 70 changed to 99)', current_setting('t.r') = 'refused 23514');
select pg_temp.check('and the card is as it was issued, with no audit entry for a change that did not happen',
  pg_temp.mean(current_setting('t.sent')) = '70' and pg_temp.events(current_setting('t.sent')) = 0);

-- ---------------------------------------------------------------- a comment on a sent card: allowed, and recorded
select pg_temp.act(format('update report_cards set principal_comment = %L where id = %L', 'Well done, QA9.', current_setting('t.sent')));
select pg_temp.check('the office may still correct a comment on a card that has gone out',
  current_setting('t.r') = 'allowed' and (select principal_comment from report_cards where id = current_setting('t.sent')::uuid) = 'Well done, QA9.');
select pg_temp.check('and it leaves one audit entry saying so, with the comment that changed and who changed it',
  pg_temp.events(current_setting('t.sent')) = 1
  and pg_temp.has_event(current_setting('t.sent'), 'Comment changed on the report card already sent for QA9 Sent')
  and exists (select 1 from audit_events where metadata->>'report_card_id' = current_setting('t.sent')
                and metadata->'changed' = '["principal_comment"]'::jsonb and actor_id = current_setting('t.admin')::uuid));
select pg_temp.act(format('update report_cards set principal_comment = %L where id = %L', 'Well done, QA9.', current_setting('t.sent')));
select pg_temp.check('saving the same comment again changes nothing and logs nothing', current_setting('t.r') = 'allowed' and pg_temp.events(current_setting('t.sent')) = 1);
select pg_temp.act(format('update report_cards set teacher_comment = %L, principal_comment = %L where id = %L', 'Good work.', 'Keep it up.', current_setting('t.sent')));
select pg_temp.check('changing both comments in one save is one entry, naming both',
  current_setting('t.r') = 'allowed' and pg_temp.events(current_setting('t.sent')) = 2
  and exists (select 1 from audit_events where metadata->>'report_card_id' = current_setting('t.sent') and metadata->'changed' = '["teacher_comment", "principal_comment"]'::jsonb));

-- ---------------------------------------------------------------- a draft is the office's own work
select pg_temp.act(format('update report_cards set data = %L, teacher_comment = %L where id = %L', pg_temp.card_data('QA9 Draft', 55, 'C+'), 'A draft comment.', current_setting('t.draft')));
select pg_temp.check('a draft card''s figures and comments change freely, and nothing is logged for it',
  current_setting('t.r') = 'allowed' and pg_temp.mean(current_setting('t.draft')) = '55' and pg_temp.events(current_setting('t.draft')) = 0);

-- ---------------------------------------------------------------- the normal route: withdraw, change, send again
select pg_temp.act(format('update report_cards set published_at = null where id = %L', current_setting('t.sent')));
select pg_temp.check('withdrawing a sent card is allowed and logged', current_setting('t.r') = 'allowed' and pg_temp.has_event(current_setting('t.sent'), 'Report card withdrawn for QA9 Sent'));
select pg_temp.act(format('update report_cards set data = %L where id = %L', pg_temp.card_data('QA9 Sent', 72, 'B+'), current_setting('t.sent')));
select pg_temp.check('and once withdrawn its figures can be changed', current_setting('t.r') = 'allowed' and pg_temp.mean(current_setting('t.sent')) = '72');
select pg_temp.act(format('update report_cards set published_at = now() where id = %L', current_setting('t.sent')));
select pg_temp.check('sending it again is logged', current_setting('t.r') = 'allowed' and pg_temp.has_event(current_setting('t.sent'), 'Report card published for QA9 Sent'));
select pg_temp.act(format('update report_cards set data = %L where id = %L', pg_temp.card_data('QA9 Sent', 99, 'A'), current_setting('t.sent')));
select pg_temp.check('and once more the figures are fixed', current_setting('t.r') = 'refused 23514' and pg_temp.mean(current_setting('t.sent')) = '72');
select pg_temp.act(format('update report_cards set published_at = null, data = %L where id = %L', pg_temp.card_data('QA9 Sent', 73, 'B+'), current_setting('t.sent')));
select pg_temp.check('withdrawing and rewriting in one statement is allowed, because the withdrawal is the logged step',
  current_setting('t.r') = 'allowed' and pg_temp.mean(current_setting('t.sent')) = '73'
  and (select count(*) from audit_events where metadata->>'report_card_id' = current_setting('t.sent') and event = 'Report card withdrawn for QA9 Sent') = 2);

rollback;
