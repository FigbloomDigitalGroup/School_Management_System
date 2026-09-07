-- Figbloom School Systems — schema
-- Multi-tenant by tenant_id on every row. Tenants resolve by path (/s/<slug>).
-- Run: supabase db reset

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tenants
create type tenant_status as enum ('active','trial','onboarding','overdue','suspended','setup_stalled');
create type school_level  as enum ('primary','secondary','combined');
create type plan_code     as enum ('standard','institution','county');

create table tenants (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  county           text not null,
  level            school_level not null default 'secondary',
  moe_registration text,
  plan             plan_code not null default 'standard',
  status           tenant_status not null default 'onboarding',
  accent           text not null default '#1B4D2E' check (accent ~* '^#[0-9a-f]{6}$'),
  logo_url         text,
  licensed_seats   int not null default 0 check (licensed_seats >= 0),
  created_at       timestamptz not null default now()
);
create index on tenants (status);

-- ---------------------------------------------------------------- people
create type app_role as enum ('super_admin','school_admin','teacher','parent','student');

create table profiles (
  id           uuid primary key references auth.users on delete cascade,
  tenant_id    uuid references tenants on delete cascade,
  role         app_role not null,
  full_name    text not null,
  email        text,
  phone        text,
  staff_title  text,
  created_at   timestamptz not null default now(),
  -- a super admin belongs to no school; everyone else must
  constraint tenant_required check ((role = 'super_admin') = (tenant_id is null))
);
create index on profiles (tenant_id, role);

-- ---------------------------------------------------------------- academic year
create table terms (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  name       text not null,
  year       int  not null,
  index      int  not null check (index between 1 and 3),
  starts_on  date not null,
  ends_on    date not null,
  is_current boolean not null default false,
  unique (tenant_id, year, index),
  check (ends_on > starts_on)
);
-- only one current term per school
create unique index one_current_term on terms (tenant_id) where is_current;

create table classes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants on delete cascade,
  name             text not null,
  form_level       int  not null check (form_level between 1 and 4),
  stream           text,
  class_teacher_id uuid references profiles on delete set null,
  room             text,
  unique (tenant_id, name)
);

create table subjects (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants on delete cascade,
  name      text not null,
  code      text not null,
  is_core   boolean not null default true,
  unique (tenant_id, code)
);

create table students (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants on delete cascade,
  admission_no  text not null,
  full_name     text not null,
  class_id      uuid not null references classes on delete restrict,
  date_of_birth date,
  boarding      boolean not null default false,
  active        boolean not null default true,
  profile_id    uuid references profiles on delete set null,
  unique (tenant_id, admission_no)
);
create index on students (tenant_id, class_id);

create type relationship as enum ('mother','father','guardian');

create table guardians (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants on delete cascade,
  profile_id       uuid not null references profiles on delete cascade,
  student_id       uuid not null references students on delete cascade,
  relationship     relationship not null default 'guardian',
  is_primary_payer boolean not null default false,
  unique (profile_id, student_id)
);
create index on guardians (profile_id);

-- teachers are assigned per class per subject
create table teaching_assignments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  teacher_id uuid not null references profiles on delete cascade,
  class_id   uuid not null references classes on delete cascade,
  subject_id uuid not null references subjects on delete cascade,
  unique (class_id, subject_id)
);
create index on teaching_assignments (teacher_id);

-- ---------------------------------------------------------------- attendance
create type attendance_mark as enum ('present','absent','late','excused');

create table attendance (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  student_id uuid not null references students on delete cascade,
  class_id   uuid not null references classes on delete cascade,
  term_id    uuid not null references terms on delete cascade,
  taken_by   uuid not null references profiles on delete restrict,
  taken_on   date not null,
  mark       attendance_mark not null default 'present',
  note       text,
  created_at timestamptz not null default now(),
  -- one register per learner per day; a resubmit updates, never duplicates
  unique (student_id, taken_on)
);
create index on attendance (tenant_id, class_id, taken_on);

-- ---------------------------------------------------------------- marks
create table exams (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  term_id      uuid not null references terms on delete cascade,
  name         text not null,
  out_of       int  not null default 100 check (out_of > 0),
  published_at timestamptz,
  unique (term_id, name)
);

create table marks (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  exam_id    uuid not null references exams on delete cascade,
  student_id uuid not null references students on delete cascade,
  subject_id uuid not null references subjects on delete cascade,
  score      int check (score is null or score >= 0),
  entered_by uuid not null references profiles on delete restrict,
  entered_at timestamptz not null default now(),
  unique (exam_id, student_id, subject_id)
);
create index on marks (tenant_id, exam_id);

-- score must fit the paper it belongs to
create or replace function marks_within_paper() returns trigger language plpgsql as $$
begin
  if new.score is not null and new.score > (select out_of from exams where id = new.exam_id) then
    raise exception 'score % exceeds the paper total', new.score;
  end if;
  return new;
end $$;
create trigger marks_within_paper before insert or update on marks
  for each row execute function marks_within_paper();

-- ---------------------------------------------------------------- fees
create type fee_scope      as enum ('all','boarders','day','form_level');
create type invoice_status as enum ('unpaid','part_paid','paid','overdue');
create type payment_status as enum ('pending','success','failed','cancelled','timeout');
create type payment_method as enum ('mpesa','bank','cash');

create table fee_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  term_id      uuid not null references terms on delete cascade,
  name         text not null,
  amount_cents bigint not null check (amount_cents > 0),
  applies_to   fee_scope not null default 'all',
  form_level   int check (form_level between 1 and 4),
  check ((applies_to = 'form_level') = (form_level is not null))
);

create table fee_invoices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  student_id  uuid not null references students on delete cascade,
  term_id     uuid not null references terms on delete cascade,
  total_cents bigint not null check (total_cents >= 0),
  paid_cents  bigint not null default 0 check (paid_cents >= 0),
  due_on      date not null,
  status      invoice_status not null default 'unpaid',
  unique (student_id, term_id)
);
create index on fee_invoices (tenant_id, status);

create table payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants on delete cascade,
  invoice_id          uuid not null references fee_invoices on delete cascade,
  amount_cents        bigint not null check (amount_cents > 0),
  method              payment_method not null default 'mpesa',
  msisdn              text,
  checkout_request_id text unique,
  mpesa_receipt       text unique,
  status              payment_status not null default 'pending',
  failure_reason      text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);
create index on payments (tenant_id, status);

-- a successful payment is the only thing that moves an invoice
create or replace function apply_payment() returns trigger language plpgsql as $$
begin
  if new.status = 'success' and (old.status is distinct from 'success') then
    update fee_invoices
       set paid_cents = paid_cents + new.amount_cents,
           status = case
             when paid_cents + new.amount_cents >= total_cents then 'paid'
             when due_on < current_date then 'overdue'
             else 'part_paid' end
     where id = new.invoice_id;
  end if;
  return new;
end $$;
create trigger apply_payment after insert or update on payments
  for each row execute function apply_payment();

-- ---------------------------------------------------------------- comms
create table announcements (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  author_id    uuid not null references profiles on delete restrict,
  subject      text not null,
  body         text not null,
  audience     jsonb not null default '{"kind":"whole_school"}'::jsonb,
  channels     text[] not null default array['in_app'],
  published_at timestamptz,
  created_at   timestamptz not null default now()
);
create index on announcements (tenant_id, published_at desc);

create table announcement_reads (
  announcement_id uuid not null references announcements on delete cascade,
  profile_id      uuid not null references profiles on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, profile_id)
);

create table assignments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  class_id   uuid not null references classes on delete cascade,
  subject_id uuid not null references subjects on delete cascade,
  set_by     uuid not null references profiles on delete restrict,
  title      text not null,
  body       text not null,
  due_on     date not null,
  hand_in    text not null default 'paper',
  created_at timestamptz not null default now()
);

create table assignment_submissions (
  assignment_id uuid not null references assignments on delete cascade,
  student_id    uuid not null references students on delete cascade,
  marked_done_at timestamptz not null default now(),
  primary key (assignment_id, student_id)
);

-- ---------------------------------------------------------------- oversight
create table audit_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references tenants on delete cascade,
  actor_id    uuid references profiles on delete set null,
  actor_label text not null,
  event       text not null,
  category    text not null check (category in ('provisioning','access','academic','financial')),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index on audit_events (tenant_id, created_at desc);

create table impersonation_sessions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  staff_id     uuid not null references profiles on delete restrict,
  reason       text not null,
  scope        text not null default 'read_only' check (scope in ('read_only','write')),
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  writes_count int not null default 0
);

create table invites (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  role       app_role not null,
  full_name  text not null,
  email      text,
  phone      text,
  token      text not null unique default encode(gen_random_bytes(24), 'hex'),
  sent_email_at timestamptz,
  sent_sms_at   timestamptz,
  accepted_at   timestamptz,
  expires_at timestamptz not null default now() + interval '7 days'
);
create index on invites (tenant_id, accepted_at);
