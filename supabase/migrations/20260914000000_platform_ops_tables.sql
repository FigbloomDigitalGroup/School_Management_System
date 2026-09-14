-- Backing tables for the three platform console pages that were still
-- illustrative after FIG-158's first pass (Usage, Impersonation, Audit are
-- already real). Health stays illustrative — it would need real uptime/
-- latency monitoring this project has no infrastructure for at all, and
-- that's still a product decision, not a coding task.

-- ---------------------------------------------------- subscriptions/pricing
-- Placeholder per-term list prices — replace these three rows with the real
-- figures (`update plan_pricing set price_cents = ... where plan = ...`).
create table plan_pricing (
  plan        plan_code primary key,
  price_cents int not null check (price_cents >= 0)
);
insert into plan_pricing (plan, price_cents) values
  ('standard',    50000_00),
  ('institution', 120000_00),
  ('county',      300000_00);

alter table tenants
  add column price_cents_override int check (price_cents_override >= 0),
  add column trial_ends_at        timestamptz,
  add column renews_on            date;
comment on column tenants.price_cents_override is 'Overrides plan_pricing for a negotiated rate; null means the plan''s list price applies.';

-- ---------------------------------------------------------- incidents
-- Staff-declared, not automated monitoring — there is no telemetry pipeline
-- behind this, only a place for support to record what happened.
create type incident_severity as enum ('SEV-1', 'SEV-2', 'SEV-3');
create type incident_status   as enum ('investigating', 'fix_in_review', 'resolved');

create table platform_incidents (
  id               uuid primary key default gen_random_uuid(),
  severity         incident_severity not null,
  title            text not null,
  summary          text not null,
  affected_schools int not null default 0 check (affected_schools >= 0),
  status           incident_status not null default 'investigating',
  opened_at        timestamptz not null default now(),
  resolved_at      timestamptz,
  created_by       uuid references profiles (id) default auth.uid()
);
create index on platform_incidents (status);
create index on platform_incidents (opened_at desc);

-- ---------------------------------------------------------- SaaS invoices
-- Figbloom billing a school for its licence — separate from fee_invoices
-- (a school billing its own parents). No payment gateway behind this yet;
-- staff record invoices and mark them paid once reconciled against the bank.
-- "Overdue" is not a stored state — nothing here runs on a schedule to flip
-- it, so it's derived from due_date at read time instead of drifting stale.
create type platform_invoice_status as enum ('due', 'paid');

create table platform_invoices (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  amount_cents int not null check (amount_cents > 0),
  due_date     date not null,
  status       platform_invoice_status not null default 'due',
  paid_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index on platform_invoices (tenant_id);
create index on platform_invoices (status);

-- ---------------------------------------------------------------------- RLS
alter table plan_pricing       enable row level security;
alter table platform_incidents enable row level security;
alter table platform_invoices  enable row level security;

-- Reference data platform staff maintain; not school-facing.
create policy plan_pricing_super on plan_pricing for all
  using (is_super()) with check (is_super());

create policy platform_incidents_super on platform_incidents for all
  using (is_super()) with check (is_super());

create policy platform_invoices_super on platform_invoices for all
  using (is_super()) with check (is_super());
