-- School inventory: what the school owns, and who has it.
--
--   inventory_items   the register. Either one tracked asset (a projector,
--                     a microscope: tracking 'asset', quantity 1, usually
--                     with an asset tag) or a stock line of identical
--                     copies (60 copies of KLB Biology Form 2, 40 hockey
--                     sticks: tracking 'stock', quantity = copies owned).
--   inventory_issues  one hand-out: an item, or N copies of a stock line,
--                     to one learner or one member of staff, with when it's
--                     due back. Closed as returned, returned damaged, or
--                     lost. Never deleted, so it is the item's history and
--                     the holder's history both.
--
-- The office (may_administer) keeps the register and hands things out; a
-- separate storekeeper role isn't worth its weight yet. Staff can read the
-- register and every issue (a class teacher chasing textbooks needs to see
-- who has what); families read only their own children's issues, and the
-- items those name.
--
-- Availability (copies not out with anyone) is enforced here, under a row
-- lock on the item, not just shown in the app: two people issuing the last
-- copy at once can't both succeed.

create table inventory_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants on delete cascade,
  name             text not null check (char_length(trim(name)) between 1 and 160),
  category         text not null default 'other' check (category in (
                     'textbooks', 'furniture', 'lab_equipment', 'sports', 'ict', 'uniforms',
                     'music', 'kitchen', 'stationery', 'tools', 'other')),
  tracking         text not null default 'asset' check (tracking in ('asset', 'stock')),
  -- copies owned; an asset is always exactly one thing
  quantity         int not null default 1 check (quantity >= 0),
  -- the sticker or engraving on it, or a serial number
  asset_tag        text check (asset_tag is null or char_length(asset_tag) between 1 and 80),
  condition        text not null default 'good' check (condition in ('new', 'good', 'fair', 'poor', 'broken')),
  -- "Library store", "Chemistry lab", "Games store"
  location         text check (location is null or char_length(location) <= 120),
  purchased_on     date,
  -- per copy for stock, for the thing itself for an asset
  unit_cost_cents  bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  notes            text check (notes is null or char_length(notes) <= 2000),
  -- written off (lost, disposed of): kept for its history, can't be issued
  retired_at       timestamptz,
  created_by       uuid references profiles on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (tracking = 'stock' or quantity = 1)
);
-- one tag per school, whatever the case it was typed in
create unique index inventory_items_tag_unique on inventory_items (tenant_id, lower(asset_tag)) where asset_tag is not null;
create index on inventory_items (tenant_id, category, name);

create table inventory_issues (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants on delete cascade,
  item_id             uuid not null references inventory_items on delete cascade,
  -- exactly one holder: a learner, or a member of staff
  student_id          uuid references students on delete cascade,
  profile_id          uuid references profiles on delete cascade,
  quantity            int not null default 1 check (quantity > 0),
  issued_by           uuid references profiles on delete set null,
  issued_at           timestamptz not null default now(),
  -- null = no date (a teacher's laptop for as long as they're here)
  due_on              date,
  condition_out       text check (condition_out is null or condition_out in ('new', 'good', 'fair', 'poor', 'broken')),
  status              text not null default 'out' check (status in ('out', 'returned', 'damaged', 'lost')),
  returned_condition  text check (returned_condition is null or returned_condition in ('new', 'good', 'fair', 'poor', 'broken')),
  closed_at           timestamptz,
  closed_by           uuid references profiles on delete set null,
  note                text check (note is null or char_length(note) <= 1000),
  check (num_nonnulls(student_id, profile_id) = 1),
  check ((status = 'out') = (closed_at is null))
);
create index on inventory_issues (item_id, issued_at desc);
create index on inventory_issues (student_id, issued_at desc) where student_id is not null;
create index on inventory_issues (profile_id, issued_at desc) where profile_id is not null;
create index on inventory_issues (tenant_id, status, due_on);

alter table inventory_items enable row level security;
alter table inventory_issues enable row level security;

-- ---------------------------------------------------------------- items

create or replace function inventory_items_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and NEW.tenant_id <> OLD.tenant_id then
    raise exception 'An item cannot be moved to another school' using errcode = '42501';
  end if;
  NEW.name := trim(NEW.name);
  NEW.asset_tag := nullif(trim(coalesce(NEW.asset_tag, '')), '');
  NEW.location := nullif(trim(coalesce(NEW.location, '')), '');
  NEW.updated_at := now();
  return NEW;
end;
$$;

create trigger inventory_items_stamp before insert or update on inventory_items
  for each row execute function inventory_items_stamp();

-- Copies of an item out with someone right now.
create or replace function inventory_out_count(p_item_id uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(quantity), 0)::int from inventory_issues where item_id = p_item_id and status = 'out'
$$;

-- A stock line can't be cut below what's out on loan.
create or replace function inventory_items_check_quantity() returns trigger
language plpgsql set search_path = public as $$
declare
  v_out int;
begin
  -- Lost copies coming off the count (inventory_issues_close, below) are
  -- already no longer out; only a person editing the register is checked.
  if pg_trigger_depth() > 1 then return NEW; end if;
  if NEW.quantity < OLD.quantity then
    v_out := inventory_out_count(NEW.id);
    if NEW.quantity < v_out then
      raise exception '% copies are out with people; the school cannot own fewer than that', v_out using errcode = '23514';
    end if;
  end if;
  return NEW;
end;
$$;

create trigger inventory_items_check_quantity before update of quantity on inventory_items
  for each row execute function inventory_items_check_quantity();

create policy inventory_items_read on inventory_items for select
  using (
    is_super()
    or may_administer(tenant_id)
    or (tenant_id = my_tenant() and is_staff())
    -- a family, or a learner, sees the items they've been issued
    or exists (
      select 1 from inventory_issues i
      where i.item_id = inventory_items.id
        and (i.profile_id = auth.uid() or i.student_id in (select my_students()))
    )
  );
create policy inventory_items_write on inventory_items for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

-- ---------------------------------------------------------------- issues

-- Fills in who and when, keeps a closed issue closed, and checks the holder
-- belongs to this school and the copies are actually on the shelf.
create or replace function inventory_issues_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_item  inventory_items%rowtype;
  v_out   int;
begin
  if TG_OP = 'UPDATE' then
    if (NEW.item_id, NEW.tenant_id, NEW.quantity, NEW.issued_at) is distinct from (OLD.item_id, OLD.tenant_id, OLD.quantity, OLD.issued_at)
       or NEW.student_id is distinct from OLD.student_id or NEW.profile_id is distinct from OLD.profile_id then
      raise exception 'Return this and issue it again instead of changing who has it' using errcode = '42501';
    end if;
    if OLD.status <> 'out' then
      if (NEW.status, NEW.returned_condition) is distinct from (OLD.status, OLD.returned_condition) then
        raise exception 'This has already been closed' using errcode = '42501';
      end if;
      -- a note can still be added; when and by whom it was closed can't be rewritten
      NEW.closed_at := OLD.closed_at;
      NEW.closed_by := OLD.closed_by;
      return NEW;
    end if;
    if OLD.status = 'out' and NEW.status <> 'out' then
      NEW.closed_at := now();
      NEW.closed_by := coalesce(auth.uid(), NEW.closed_by);
    end if;
    return NEW;
  end if;

  -- INSERT
  select * into v_item from inventory_items where id = NEW.item_id for update;
  if v_item.id is null or v_item.tenant_id <> NEW.tenant_id then
    raise exception 'That item is not in this school''s register' using errcode = '42501';
  end if;
  if v_item.retired_at is not null then
    raise exception '% has been written off and cannot be issued', v_item.name using errcode = '23514';
  end if;
  if NEW.student_id is not null and not exists (select 1 from students s where s.id = NEW.student_id and s.tenant_id = NEW.tenant_id and s.active) then
    raise exception 'That learner is not an active learner at this school' using errcode = '42501';
  end if;
  if NEW.profile_id is not null and not exists (
    select 1 from profiles p where p.id = NEW.profile_id and p.tenant_id = NEW.tenant_id and p.role not in ('parent', 'student')
  ) then
    raise exception 'Items can be issued to learners or to staff of this school' using errcode = '42501';
  end if;

  -- Counted inline rather than through the stable helper: a volatile query
  -- also sees the rows a multi-row insert has already added.
  select coalesce(sum(quantity), 0) into v_out from inventory_issues where item_id = NEW.item_id and status = 'out';
  if v_out + NEW.quantity > v_item.quantity then
    raise exception '%', case when v_item.tracking = 'asset'
      then format('%s is already out with someone', v_item.name)
      else format('Only %s of %s on the shelf', greatest(v_item.quantity - v_out, 0), v_item.name) end
      using errcode = '23514';
  end if;

  NEW.status := 'out';
  NEW.closed_at := null;
  NEW.closed_by := null;
  NEW.issued_by := coalesce(auth.uid(), NEW.issued_by);
  NEW.issued_at := now();
  NEW.condition_out := coalesce(NEW.condition_out, v_item.condition);
  return NEW;
end;
$$;

create trigger inventory_issues_guard before insert or update on inventory_issues
  for each row execute function inventory_issues_guard();

-- What closing an issue does to the register: a lost asset is written off,
-- lost copies come off the stock count, and an asset that comes back
-- carries the condition it came back in.
create or replace function inventory_issues_close() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if OLD.status <> 'out' or NEW.status = 'out' then return NEW; end if;
  if NEW.status = 'lost' then
    update inventory_items
    set retired_at = case when tracking = 'asset' then now() else retired_at end,
        quantity   = case when tracking = 'stock' then greatest(quantity - NEW.quantity, 0) else quantity end
    where id = NEW.item_id;
  elsif NEW.returned_condition is not null then
    update inventory_items set condition = NEW.returned_condition
    where id = NEW.item_id and tracking = 'asset';
  end if;
  return NEW;
end;
$$;

create trigger inventory_issues_close after update of status on inventory_issues
  for each row execute function inventory_issues_close();

create policy inventory_issues_read on inventory_issues for select
  using (
    is_super()
    or may_administer(tenant_id)
    or (tenant_id = my_tenant() and is_staff())
    or profile_id = auth.uid()
    or student_id in (select my_students())
  );
-- No delete: an issue made in error is closed as returned, so the history stays whole.
create policy inventory_issues_insert on inventory_issues for insert
  with check (may_administer(tenant_id));
create policy inventory_issues_update on inventory_issues for update
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

-- ---------------------------------------------------------------- whole class

-- Textbooks go out a class at a time at the start of the year: one copy to
-- every active learner in the class who doesn't already have one out. All
-- or nothing: if there aren't enough copies on the shelf for everyone,
-- nobody gets one and the error says how many are short. Returns how many
-- learners were issued a copy.
create or replace function issue_item_to_class(p_item_id uuid, p_class_id uuid, p_due_on date)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_item   inventory_items%rowtype;
  v_needed int;
  v_free   int;
begin
  select * into v_item from inventory_items where id = p_item_id for update;
  if v_item.id is null or not may_administer(v_item.tenant_id) then
    raise exception 'Only the school office can issue items' using errcode = '42501';
  end if;
  if not exists (select 1 from classes c where c.id = p_class_id and c.tenant_id = v_item.tenant_id) then
    raise exception 'That class is not in this school' using errcode = '42501';
  end if;
  if v_item.tracking <> 'stock' then
    raise exception 'Only a stock item (many copies) can go to a whole class' using errcode = '22023';
  end if;

  select count(*) into v_needed
  from students s
  where s.class_id = p_class_id and s.active and s.tenant_id = v_item.tenant_id
    and not exists (select 1 from inventory_issues i where i.item_id = p_item_id and i.student_id = s.id and i.status = 'out');
  if v_needed = 0 then return 0; end if;

  v_free := v_item.quantity - inventory_out_count(p_item_id);
  if v_needed > v_free then
    raise exception 'The class needs % copies of % but only % are on the shelf', v_needed, v_item.name, greatest(v_free, 0)
      using errcode = '23514';
  end if;

  insert into inventory_issues (tenant_id, item_id, student_id, quantity, due_on)
  select v_item.tenant_id, p_item_id, s.id, 1, p_due_on
  from students s
  where s.class_id = p_class_id and s.active and s.tenant_id = v_item.tenant_id
    and not exists (select 1 from inventory_issues i where i.item_id = p_item_id and i.student_id = s.id and i.status = 'out');
  return v_needed;
end;
$$;

grant execute on function issue_item_to_class(uuid, uuid, date) to authenticated;
