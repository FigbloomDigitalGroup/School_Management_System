-- Report cards: one per learner per term, issued by the school.
--
-- The card is a snapshot (data jsonb) taken when the office prepares a
-- class: marks per exam, the average and grade per subject, class means,
-- position, attendance and fee balance as they stood that day. A family
-- downloads exactly what the school issued, and a mark corrected next term
-- doesn't quietly change last term's card. Position and class means need
-- every classmate's marks, which a family can't read, so they can only be
-- worked out on the school's side and stored.
--
-- Shape of data: packages/shared/src/reportCards.ts (ReportCardData) is the
-- one place that writes and reads it.
--
-- Who does what:
--   - school admins (may_administer) prepare, edit, publish and withdraw;
--   - the class teacher writes the class teacher's comment for their own
--     class, until the card is published (set_report_card_teacher_comment);
--   - staff read every card at the school; a learner and their guardians
--     read the learner's cards once published.

create table report_cards (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants on delete cascade,
  term_id           uuid not null references terms on delete cascade,
  student_id        uuid not null references students on delete cascade,
  class_id          uuid references classes on delete set null,
  data              jsonb not null,
  teacher_comment   text,
  principal_comment text,
  published_at      timestamptz,
  prepared_by       uuid references profiles on delete set null default auth.uid(),
  prepared_at       timestamptz not null default now(),
  unique (term_id, student_id),
  constraint report_cards_data_shape check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 100000),
  constraint report_cards_comment_len check (
    coalesce(char_length(teacher_comment), 0) <= 600 and coalesce(char_length(principal_comment), 0) <= 600
  )
);
create index on report_cards (tenant_id, term_id, class_id);
create index on report_cards (student_id);

alter table report_cards enable row level security;

create policy report_cards_read on report_cards for select
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and is_staff())
    or (published_at is not null and student_id in (select my_students()))
  );

create policy report_cards_write on report_cards for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

create trigger report_cards_student_tenant before insert or update of tenant_id, student_id on report_cards
  for each row execute function enforce_student_tenant();

-- The term and class must be this school's too.
create or replace function report_cards_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from terms where id = new.term_id and tenant_id = new.tenant_id)
     or (new.class_id is not null and not exists (select 1 from classes where id = new.class_id and tenant_id = new.tenant_id)) then
    raise exception 'That term or class belongs to another school.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger report_cards_consistent before insert or update of tenant_id, term_id, class_id on report_cards
  for each row execute function report_cards_consistent();

-- Publishing and withdrawing go in the audit log, one row per card, so
-- "when did this family's card go out, and who sent it" has an answer.
create or replace function report_cards_audit_publish() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.published_at is null) <> (new.published_at is null) then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (new.tenant_id, auth.uid(), my_actor_label(),
            format('Report card %s for %s', case when new.published_at is null then 'withdrawn' else 'published' end,
                   coalesce(new.data #>> '{learner,name}', 'a learner')),
            'academic',
            jsonb_build_object('report_card_id', new.id, 'term_id', new.term_id, 'student_id', new.student_id));
  end if;
  return new;
end $$;
create trigger report_cards_audit_publish after update of published_at on report_cards
  for each row execute function report_cards_audit_publish();

-- The class teacher's comment, written by the class teacher (or an admin).
-- A teacher can't otherwise write report_cards, and only this column, and
-- only until the card is out.
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
    may_administer(c.tenant_id)
    or (c.tenant_id = my_tenant() and my_role() = 'teacher'
        and exists (select 1 from classes where id = c.class_id and class_teacher_id = auth.uid()))
  ) then
    raise exception 'Only the class teacher can comment on this report card.' using errcode = '42501';
  end if;
  if c.published_at is not null and not may_administer(c.tenant_id) then
    raise exception 'This report card has gone out to the family. Ask the office to withdraw it to change the comment.' using errcode = '42501';
  end if;
  update report_cards
     set teacher_comment = nullif(left(trim(coalesce(p_comment, '')), 600), '')
   where id = c.id;
end $$;

revoke execute on function set_report_card_teacher_comment(uuid, text) from public, anon;
grant execute on function set_report_card_teacher_comment(uuid, text) to authenticated;
