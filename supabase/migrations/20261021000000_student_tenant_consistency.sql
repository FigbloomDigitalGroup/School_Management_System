-- A row that names a learner must belong to that learner's school.
--
-- RLS only ever checks a row's own tenant_id (may_administer(tenant_id),
-- tenant_id = my_tenant()), never that the student_id on it is in that same
-- tenant. So a school admin -- or an org admin, who can create schools of
-- their own -- could insert a guardians row in THEIR school pointing at
-- ANOTHER school's learner, and every guardian read branch (invoice_read,
-- payment_read, payment_proofs_read, bus_updates_read, my_students() and
-- everything built on it) would then hand them that child's data. The same
-- gap let them plant marks or attendance against another school's learner,
-- which that learner's own parents would see.
--
-- Triggers close it where the rows are written, for every table carrying both
-- columns, whichever role writes and whichever policy let the write through.
-- Guardians additionally have to be accounts of the same school, and
-- payments / payment proofs have to be against an invoice of their own
-- school. With guardians consistent, the guardian read branches above can
-- only ever reach the guardian's own school, so those policies stay as they
-- are.
--
-- Existing rows aren't changed; the block at the end warns about any that
-- already break the rule, for someone to look at by hand.

create or replace function enforce_student_tenant() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from students s where s.id = new.student_id and s.tenant_id = new.tenant_id) then
    raise exception 'That learner does not belong to this school.' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function enforce_guardian_profile_tenant() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles p where p.id = new.profile_id and p.tenant_id = new.tenant_id) then
    raise exception 'That account does not belong to this school.' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function enforce_invoice_tenant() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from fee_invoices i where i.id = new.invoice_id and i.tenant_id = new.tenant_id) then
    raise exception 'That invoice does not belong to this school.' using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'guardians', 'attendance', 'marks', 'fee_invoices', 'student_documents', 'student_transport',
    'enrollments', 'course_marks', 'course_grades', 'cbe_results', 'cbe_assessment_comments'
  ] loop
    execute format($f$
      create trigger %1$s_student_tenant before insert or update of tenant_id, student_id on %1$s
        for each row execute function enforce_student_tenant();
    $f$, t);
  end loop;
end $$;

create trigger guardians_profile_tenant before insert or update of tenant_id, profile_id on guardians
  for each row execute function enforce_guardian_profile_tenant();

create trigger payments_invoice_tenant before insert or update of tenant_id, invoice_id on payments
  for each row execute function enforce_invoice_tenant();
create trigger payment_proofs_invoice_tenant before insert or update of tenant_id, invoice_id on payment_proofs
  for each row execute function enforce_invoice_tenant();

-- Report rows written before these triggers existed that already break the rule.
do $$
declare t text; n bigint;
begin
  foreach t in array array[
    'guardians', 'attendance', 'marks', 'fee_invoices', 'student_documents', 'student_transport',
    'enrollments', 'course_marks', 'course_grades', 'cbe_results', 'cbe_assessment_comments'
  ] loop
    execute format(
      'select count(*) from %1$s x join students s on s.id = x.student_id where s.tenant_id <> x.tenant_id', t
    ) into n;
    if n > 0 then raise warning '%: % row(s) name a learner from another school', t, n; end if;
  end loop;

  select count(*) into n from guardians g join profiles p on p.id = g.profile_id
    where p.tenant_id is distinct from g.tenant_id;
  if n > 0 then raise warning 'guardians: % row(s) link an account from another school', n; end if;

  foreach t in array array['payments', 'payment_proofs'] loop
    execute format(
      'select count(*) from %1$s x join fee_invoices i on i.id = x.invoice_id where i.tenant_id <> x.tenant_id', t
    ) into n;
    if n > 0 then raise warning '%: % row(s) are against another school''s invoice', t, n; end if;
  end loop;
end $$;
