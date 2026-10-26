-- Electronic signatures, with dates, on four kinds of document:
--
--   student_document  a file in a learner's records (admission form, consent
--                     form). Staff ask the learner's guardians or colleagues
--                     to sign; staff may also sign one themselves.
--   attachment        a file on an announcement or class message marked
--                     "needs signature" (a permission slip). Every family
--                     the message reaches is asked to sign once it is sent.
--   report_card       signed by the principal (the office) and the class
--                     teacher; the signatures are stamped on the PDF.
--   fee_invoice       signed by the bursar (the office); families see it on
--                     their fees page.
--
-- One model for all four, keyed by (doc_kind, doc_id) rather than a foreign
-- key per kind:
--
--   signature_requests  who has been asked to sign what, and in what capacity.
--   signatures          what they signed: typed full name, the drawn mark
--                       (strokes, see packages/shared/src/signatures.ts) or a
--                       typed one, the server's time, the browser, and a
--                       SHA-256 of the document as it stood when signed.
--
-- Signatures are evidence, so nobody edits or deletes one: the only change
-- is the office voiding it, with a reason, after which the signer can sign
-- again. Every write goes through the security-definer functions below;
-- the tables have read policies only.
--
-- The hash: report cards and invoices are rows, so the database hashes them
-- itself (document_fingerprint) and can later tell whether the card was
-- changed after it was signed; a changed card's old signatures are not
-- stamped on its PDF. Files are bytes in storage the database can't read, so
-- the signer's browser hashes the file it downloaded and sends that.

-- ---------------------------------------------------------------- tables
create table signature_requests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  doc_kind     text not null check (doc_kind in ('student_document', 'attachment', 'report_card', 'fee_invoice')),
  doc_id       uuid not null,
  signer_id    uuid not null references profiles on delete cascade,
  capacity     text not null check (capacity in ('guardian', 'learner', 'staff', 'recipient', 'principal', 'class_teacher', 'bursar')),
  note         text check (char_length(note) <= 300),
  requested_by uuid references profiles on delete set null default auth.uid(),
  requested_at timestamptz not null default now(),
  unique (doc_kind, doc_id, signer_id, capacity)
);
create index on signature_requests (signer_id);
create index on signature_requests (doc_kind, doc_id);

create table signatures (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  doc_kind    text not null check (doc_kind in ('student_document', 'attachment', 'report_card', 'fee_invoice')),
  doc_id      uuid not null,
  request_id  uuid references signature_requests on delete set null,
  signer_id   uuid references profiles on delete set null,
  capacity    text not null check (capacity in ('guardian', 'learner', 'staff', 'recipient', 'principal', 'class_teacher', 'bursar')),
  full_name   text not null check (char_length(trim(full_name)) between 2 and 120),
  style       text not null check (style in ('drawn', 'typed')),
  -- drawn: [[x,y,x,y,...], ...] in a 600 x 200 box; typed: null (the name is the mark)
  strokes     jsonb check (strokes is null or (jsonb_typeof(strokes) = 'array' and octet_length(strokes::text) <= 40000)),
  doc_hash    text not null check (doc_hash ~ '^[0-9a-f]{64}$'),
  user_agent  text check (char_length(user_agent) <= 400),
  signed_at   timestamptz not null default now(),
  voided_at   timestamptz,
  voided_by   uuid references profiles on delete set null,
  void_reason text,
  check ((style = 'drawn') = (strokes is not null)),
  check ((voided_at is null) = (void_reason is null))
);
-- one live signature per person per capacity per document
create unique index signatures_live on signatures (doc_kind, doc_id, signer_id, capacity) where voided_at is null;
create index on signatures (doc_kind, doc_id);
create index on signatures (tenant_id, signed_at desc);

alter table signature_requests enable row level security;
alter table signatures enable row level security;

-- Signers see their own; the school's staff see the school's. Families read
-- the signatures on their own documents through document_signatures().
create policy signature_requests_read on signature_requests for select
  using (signer_id = auth.uid() or may_administer(tenant_id) or (tenant_id = my_tenant() and is_staff()));
create policy signatures_read on signatures for select
  using (signer_id = auth.uid() or may_administer(tenant_id) or (tenant_id = my_tenant() and is_staff()));

-- Nothing but voiding changes a signature, and only once.
create or replace function signatures_immutable() returns trigger
language plpgsql set search_path = public as $$
begin
  if OLD.voided_at is not null
     or (to_jsonb(NEW) - array['voided_at', 'voided_by', 'void_reason']) <> (to_jsonb(OLD) - array['voided_at', 'voided_by', 'void_reason'])
     or NEW.voided_at is null then
    raise exception 'A signature cannot be changed, only voided' using errcode = '42501';
  end if;
  return NEW;
end;
$$;

create trigger signatures_immutable before update on signatures
  for each row execute function signatures_immutable();

-- A file to be signed must be a file (a link has no bytes to hash).
alter table attachments add column needs_signature boolean not null default false;
alter table attachments add constraint attachments_signature_file check (not needs_signature or file_path is not null);

-- ---------------------------------------------------------------- the documents
-- Which school a document belongs to, or null when it doesn't exist.
create or replace function signed_document_tenant(p_kind text, p_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'student_document' then (select tenant_id from student_documents where id = p_id)
    when 'attachment' then (select tenant_id from attachments where id = p_id and announcement_id is not null)
    when 'report_card' then (select tenant_id from report_cards where id = p_id)
    when 'fee_invoice' then (select tenant_id from fee_invoices where id = p_id)
  end
$$;

-- The same people who can read the document itself.
create or replace function may_read_signed_document(p_kind text, p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'student_document' then exists (
      select 1 from student_documents d where d.id = p_id
        and (may_administer(d.tenant_id) or (d.tenant_id = my_tenant() and (is_staff() or d.student_id in (select my_students())))))
    when 'attachment' then exists (
      select 1 from attachments a where a.id = p_id and a.announcement_id is not null and may_read_announcement(a.announcement_id))
    when 'report_card' then exists (
      select 1 from report_cards r where r.id = p_id
        and (may_administer(r.tenant_id) or (r.tenant_id = my_tenant() and is_staff())
             or (r.published_at is not null and r.student_id in (select my_students()))))
    when 'fee_invoice' then exists (
      select 1 from fee_invoices i where i.id = p_id
        and (may_administer(i.tenant_id) or (i.tenant_id = my_tenant() and i.student_id in (select my_students()))))
    else false
  end
$$;

-- What a signature on a row-backed document vouches for; null for files.
-- A report card's comments are part of it; an invoice's payments are not
-- (paying doesn't change what the bursar signed).
create or replace function document_fingerprint(p_kind text, p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'report_card' then (
      select encode(sha256(convert_to(jsonb_build_object(
               'data', r.data, 'teacher_comment', r.teacher_comment, 'principal_comment', r.principal_comment)::text, 'UTF8')), 'hex')
        from report_cards r where r.id = p_id)
    when 'fee_invoice' then (
      select encode(sha256(convert_to(jsonb_build_object(
               'id', i.id, 'student_id', i.student_id, 'term_id', i.term_id, 'total_cents', i.total_cents, 'due_on', i.due_on)::text, 'UTF8')), 'hex')
        from fee_invoices i where i.id = p_id)
  end
$$;
revoke execute on function document_fingerprint(text, uuid) from public, anon, authenticated;

-- Whether the caller may sign this document in this capacity without being
-- asked: the office as principal or bursar, a class teacher for their own
-- class's cards, staff on a learner's records.
create or replace function may_sign_unasked(p_kind text, p_id uuid, p_capacity text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_kind = 'report_card' and p_capacity = 'principal' then exists (
      select 1 from report_cards r where r.id = p_id and may_administer(r.tenant_id))
    when p_kind = 'report_card' and p_capacity = 'class_teacher' then exists (
      select 1 from report_cards r join classes c on c.id = r.class_id
       where r.id = p_id and r.tenant_id = my_tenant() and c.class_teacher_id = auth.uid())
    when p_kind = 'fee_invoice' and p_capacity = 'bursar' then exists (
      select 1 from fee_invoices i where i.id = p_id and may_administer(i.tenant_id))
    when p_kind = 'student_document' and p_capacity = 'staff' then exists (
      select 1 from student_documents d where d.id = p_id and (may_administer(d.tenant_id) or (d.tenant_id = my_tenant() and is_staff())))
    else false
  end
$$;

-- ---------------------------------------------------------------- signing
-- Signs one or many documents of a kind with the same mark: one card or a
-- whole class's. Each needs either an open request to the caller in that
-- capacity or may_sign_unasked(). Already signed (and unchanged since) is
-- skipped; signed but changed since is voided and signed again. p_hashes
-- matches p_ids one to one and is only read for files. Returns how many were
-- signed.
create or replace function sign_documents(
  p_kind text, p_ids uuid[], p_capacity text, p_full_name text, p_style text, p_strokes jsonb,
  p_hashes text[] default null, p_user_agent text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid;
  v_i       int := 0;
  v_count   int := 0;
  v_tenant  uuid;
  v_request uuid;
  v_hash    text;
  v_live    signatures%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if cardinality(p_ids) > 500 then raise exception 'Sign at most 500 documents at a time' using errcode = '22023'; end if;
  if p_kind in ('student_document', 'attachment') and (p_hashes is null or cardinality(p_hashes) <> cardinality(p_ids)) then
    raise exception 'Each file needs its hash' using errcode = '22023';
  end if;

  foreach v_id in array p_ids loop
    v_i := v_i + 1;
    v_tenant := signed_document_tenant(p_kind, v_id);
    if v_tenant is null or not may_read_signed_document(p_kind, v_id) then
      raise exception 'That document is not one you can sign' using errcode = '42501';
    end if;

    select id into v_request from signature_requests
     where doc_kind = p_kind and doc_id = v_id and signer_id = auth.uid() and capacity = p_capacity;
    if v_request is null and not may_sign_unasked(p_kind, v_id, p_capacity) then
      raise exception 'You have not been asked to sign that document' using errcode = '42501';
    end if;

    v_hash := coalesce(document_fingerprint(p_kind, v_id), lower(p_hashes[v_i]));

    select * into v_live from signatures
     where doc_kind = p_kind and doc_id = v_id and signer_id = auth.uid() and capacity = p_capacity and voided_at is null;
    if found then
      if v_live.doc_hash = v_hash then continue; end if;
      update signatures set voided_at = now(), voided_by = auth.uid(), void_reason = 'Signed again after the document changed'
       where id = v_live.id;
    end if;

    insert into signatures (tenant_id, doc_kind, doc_id, request_id, signer_id, capacity, full_name, style, strokes, doc_hash, user_agent)
    values (v_tenant, p_kind, v_id, v_request, auth.uid(), p_capacity, trim(p_full_name), p_style,
            case when p_style = 'drawn' then p_strokes end, v_hash, left(p_user_agent, 400));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
grant execute on function sign_documents(text, uuid[], text, text, text, jsonb, text[], text) to authenticated;

-- The office takes a signature back (signed by mistake, signed for the wrong
-- child). The row stays, marked void; the signer can sign again.
create or replace function void_signature(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from signatures where id = p_id and voided_at is null;
  if v_tenant is null or not may_administer(v_tenant) then
    raise exception 'Only the school office can void a signature' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 300 then
    raise exception 'Say why the signature is being voided' using errcode = '22023';
  end if;
  update signatures set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason) where id = p_id;
end;
$$;
grant execute on function void_signature(uuid, text) to authenticated;

-- ---------------------------------------------------------------- asking
-- Staff ask people to sign a learner's document: the learner's guardians,
-- the learner, or colleagues. Anyone else is refused, so a request can't be
-- used to show a learner's records to a stranger.
create or replace function request_signatures(p_doc_id uuid, p_signer_ids uuid[], p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_doc   student_documents%rowtype;
  v_count int;
begin
  select * into v_doc from student_documents where id = p_doc_id;
  if v_doc.id is null or not (may_administer(v_doc.tenant_id) or (v_doc.tenant_id = my_tenant() and is_staff())) then
    raise exception 'Only the school''s staff can ask for signatures' using errcode = '42501';
  end if;

  insert into signature_requests (tenant_id, doc_kind, doc_id, signer_id, capacity, note)
  select v_doc.tenant_id, 'student_document', v_doc.id, p.id,
         case when exists (select 1 from guardians g where g.student_id = v_doc.student_id and g.profile_id = p.id) then 'guardian'
              when p.role = 'student' then 'learner'
              else 'staff' end,
         nullif(left(trim(coalesce(p_note, '')), 300), '')
    from profiles p
   where p.id = any(p_signer_ids)
     and p.tenant_id = v_doc.tenant_id
     and (p.role in ('school_admin', 'teacher')
          or exists (select 1 from guardians g where g.student_id = v_doc.student_id and g.profile_id = p.id)
          or exists (select 1 from students s where s.id = v_doc.student_id and s.profile_id = p.id))
  on conflict (doc_kind, doc_id, signer_id, capacity) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
grant execute on function request_signatures(uuid, uuid[], text) to authenticated;

-- An attachment that needs signing asks every family the message reaches,
-- once it has been sent: as it's sent, or when the flag is set on an
-- attachment of a message already out. (A message's audience can't widen
-- after sending, so this doesn't need re-running.)
create or replace function seed_attachment_requests(p_attachment_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into signature_requests (tenant_id, doc_kind, doc_id, signer_id, capacity, requested_by)
  select a.tenant_id, 'attachment', att.id, p.id, 'recipient', a.author_id
    from attachments att
    join announcements a on a.id = att.announcement_id
    join profiles p on p.tenant_id = a.tenant_id
   where att.id = p_attachment_id
     and att.needs_signature
     and a.published_at is not null
     and p.role in ('parent', 'student')
     and audience_reaches(a.tenant_id, a.audience, p.id)
  on conflict (doc_kind, doc_id, signer_id, capacity) do nothing
$$;
revoke execute on function seed_attachment_requests(uuid) from public, anon, authenticated;

create or replace function attachments_seed_requests() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.needs_signature and NEW.announcement_id is not null then
    perform seed_attachment_requests(NEW.id);
  end if;
  return NEW;
end;
$$;
create trigger attachments_seed_requests after insert or update of needs_signature on attachments
  for each row execute function attachments_seed_requests();

create or replace function announcements_seed_requests() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if NEW.published_at is null or OLD.published_at is not null then return NEW; end if;
  for v_id in select id from attachments where announcement_id = NEW.id and needs_signature loop
    perform seed_attachment_requests(v_id);
  end loop;
  return NEW;
end;
$$;
create trigger announcements_seed_requests after update of published_at on announcements
  for each row execute function announcements_seed_requests();

-- ---------------------------------------------------------------- reading
-- The caller's unsigned requests, newest first, with what the app needs to
-- show and fetch the file. Requests for documents since deleted drop out.
create or replace function my_signature_requests()
returns table(
  request_id uuid, doc_kind text, doc_id uuid, capacity text, title text, detail text,
  bucket text, file_path text, file_name text, note text, requested_by_name text, requested_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select r.id, r.doc_kind, r.doc_id, r.capacity,
         coalesce(d.doc_type, att.title),
         coalesce(s.full_name, a.subject),
         case when d.id is not null then 'private-documents' else 'learning-media' end,
         coalesce(d.file_path, att.file_path),
         coalesce(d.file_name, att.file_name),
         r.note, rp.full_name, r.requested_at
    from signature_requests r
    left join student_documents d on r.doc_kind = 'student_document' and d.id = r.doc_id
    left join students s on s.id = d.student_id
    left join attachments att on r.doc_kind = 'attachment' and att.id = r.doc_id
    left join announcements a on a.id = att.announcement_id
    left join profiles rp on rp.id = r.requested_by
   where r.signer_id = auth.uid()
     and (d.id is not null or (att.id is not null and a.published_at is not null))
     and not exists (
       select 1 from signatures x
        where x.doc_kind = r.doc_kind and x.doc_id = r.doc_id and x.signer_id = r.signer_id
          and x.capacity = r.capacity and x.voided_at is null)
   order by r.requested_at desc
$$;
grant execute on function my_signature_requests() to authenticated;

-- Every live signature on these documents, for anyone who can read them, and
-- whether the document is still what was signed (null for files, which the
-- database can't re-hash).
create or replace function document_signatures(p_kind text, p_ids uuid[])
returns table(
  id uuid, doc_id uuid, signer_id uuid, capacity text, full_name text, style text, strokes jsonb,
  signed_at timestamptz, doc_hash text, is_current boolean
)
language sql stable security definer set search_path = public as $$
  select x.id, x.doc_id, x.signer_id, x.capacity, x.full_name, x.style, x.strokes, x.signed_at, x.doc_hash,
         case when f.fp is null then null else f.fp = x.doc_hash end
    from signatures x
    cross join lateral (select document_fingerprint(x.doc_kind, x.doc_id) as fp) f
   where x.doc_kind = p_kind
     and x.doc_id = any(p_ids)
     and x.voided_at is null
     and may_read_signed_document(p_kind, x.doc_id)
   order by x.signed_at
$$;
grant execute on function document_signatures(text, uuid[]) to authenticated;

-- Who was asked and who has signed, for the staff who asked: "12 of 30
-- families have signed the permission slip".
create or replace function signature_status(p_kind text, p_ids uuid[])
returns table(doc_id uuid, signer_id uuid, signer_name text, capacity text, requested_at timestamptz, signed_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.doc_id, r.signer_id, p.full_name, r.capacity, r.requested_at, x.signed_at
    from signature_requests r
    join profiles p on p.id = r.signer_id
    left join signatures x on x.doc_kind = r.doc_kind and x.doc_id = r.doc_id and x.signer_id = r.signer_id
                          and x.capacity = r.capacity and x.voided_at is null
   where r.doc_kind = p_kind
     and r.doc_id = any(p_ids)
     and (may_administer(r.tenant_id) or (r.tenant_id = my_tenant() and is_staff()))
   order by x.signed_at nulls first, p.full_name
$$;
grant execute on function signature_status(text, uuid[]) to authenticated;
