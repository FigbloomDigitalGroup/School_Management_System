-- Document/photo upload support: two storage buckets plus the tables that
-- record what was uploaded and why.
--
-- public-assets     — staff photos, student photos, school logos. Publicly
--                     readable (branding and avatars aren't sensitive),
--                     write restricted to staff of the owning tenant.
--                     Path: {tenant_id}/avatars/{owner_id}.{ext}
--                           {tenant_id}/branding/logo.{ext}
--
-- private-documents — student records, fee payment proof, assignment
--                     hand-ins. Not public. Read is any signed-in member of
--                     the tenant (school documents are a shared drive, not a
--                     locked vault); write is staff for their own tenant,
--                     plus two narrow self-service carve-outs: a guardian
--                     may upload proof against their own child's invoice,
--                     and a student may upload their own assignment hand-in.
--                     Path: {tenant_id}/students/{student_id}/{filename}
--                           {tenant_id}/invoices/{invoice_id}/{filename}
--                           {tenant_id}/submissions/{assignment_id}/{student_id}/{filename}

insert into storage.buckets (id, name, public)
values ('public-assets', 'public-assets', true), ('private-documents', 'private-documents', false)
on conflict (id) do nothing;

create policy public_assets_read on storage.objects for select
  using (bucket_id = 'public-assets');

create policy public_assets_write on storage.objects for all
  using (bucket_id = 'public-assets' and (is_super() or ((storage.foldername(name))[1] = my_tenant()::text and is_staff())))
  with check (bucket_id = 'public-assets' and (is_super() or ((storage.foldername(name))[1] = my_tenant()::text and is_staff())));

create policy private_docs_read on storage.objects for select
  using (bucket_id = 'private-documents' and (is_super() or (storage.foldername(name))[1] = my_tenant()::text));

create policy private_docs_staff_write on storage.objects for all
  using (bucket_id = 'private-documents' and (is_super() or ((storage.foldername(name))[1] = my_tenant()::text and is_staff())))
  with check (bucket_id = 'private-documents' and (is_super() or ((storage.foldername(name))[1] = my_tenant()::text and is_staff())));

-- a guardian may upload (never overwrite/delete) proof against their own child's invoice
create policy private_docs_guardian_proof_write on storage.objects for insert
  with check (
    bucket_id = 'private-documents'
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'invoices'
    and exists (
      select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
      where i.id::text = (storage.foldername(name))[3] and g.profile_id = auth.uid()
    )
  );

-- a student may upload (never overwrite/delete) their own assignment hand-in
create policy private_docs_student_submission_write on storage.objects for insert
  with check (
    bucket_id = 'private-documents'
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'submissions'
    and exists (
      select 1 from students s where s.id::text = (storage.foldername(name))[4] and s.profile_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------- columns
alter table profiles add column avatar_url text;
alter table students add column avatar_url text;
-- tenants.logo_url already exists (schema.sql) — this migration just adds real upload wiring for it.

alter table assignment_submissions add column file_path text;
alter table assignment_submissions add column file_name text;

-- ---------------------------------------------------------------- student documents
create table student_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  student_id  uuid not null references students on delete cascade,
  uploaded_by uuid not null references profiles on delete restrict,
  doc_type    text not null,
  file_path   text not null,
  file_name   text not null,
  uploaded_at timestamptz not null default now()
);
create index on student_documents (tenant_id, student_id);

alter table student_documents enable row level security;

create policy student_documents_read on student_documents for select
  using (is_super() or tenant_id = my_tenant());
create policy student_documents_write on student_documents for all
  using (is_super() or (tenant_id = my_tenant() and is_staff()))
  with check (is_super() or (tenant_id = my_tenant() and is_staff()));

-- ---------------------------------------------------------------- fee payment proof
create type proof_status as enum ('pending', 'confirmed', 'rejected');

create table payment_proofs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  invoice_id  uuid not null references fee_invoices on delete cascade,
  uploaded_by uuid not null references profiles on delete restrict,
  file_path   text not null,
  file_name   text not null,
  note        text,
  status      proof_status not null default 'pending',
  uploaded_at timestamptz not null default now(),
  reviewed_by uuid references profiles on delete set null,
  reviewed_at timestamptz
);
create index on payment_proofs (tenant_id, invoice_id);

alter table payment_proofs enable row level security;

create policy payment_proofs_read on payment_proofs for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or exists (select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
               where i.id = payment_proofs.invoice_id and g.profile_id = auth.uid())
  );
-- a guardian may record that they uploaded proof for their own child's invoice
create policy payment_proofs_insert_guardian on payment_proofs for insert
  with check (
    tenant_id = my_tenant()
    and status = 'pending'
    and exists (select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
                where i.id = invoice_id and g.profile_id = auth.uid())
  );
-- staff review it (confirm/reject) or record proof on a family's behalf
create policy payment_proofs_staff_manage on payment_proofs for all
  using (is_super() or (tenant_id = my_tenant() and is_staff()))
  with check (is_super() or (tenant_id = my_tenant() and is_staff()));
