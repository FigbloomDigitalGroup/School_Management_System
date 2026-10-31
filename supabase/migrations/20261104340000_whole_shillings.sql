-- FIG-1334: school money is whole shillings.
--
-- Amounts are integer cents everywhere, and sums are exact, but the edges
-- disagreed: the office could record or charge cents, Kenya's money is shown
-- with no decimals (so KSh 10,000.50 read as KSh 10,001), and M-Pesa charges
-- whole shillings only, so a balance left with cents could never be cleared
-- by it. One rule now: what the school bills, charges and records is whole
-- shillings.
--
--   * record_payment(): whole shillings, or exactly what is still owed (so a
--     balance already left with cents can be cleared at the office);
--   * charge_learner() and adjust_invoice_total(): whole shillings;
--   * fee_items: a new or changed item is whole shillings (NOT VALID: items
--     already saved are left as they are).
--
-- The screens say so before the database has to (parseShillings in
-- packages/shared), show any amount with cents exactly, and offer M-Pesa a
-- balance with cents rounded up to the shilling, which mpesa-stk-push
-- accepts and the overpayment log (20261103400000) records.
--
-- The checks are added to each function's current body, after the line
-- that refuses a missing amount; the migration stops if that line isn't
-- there.
--
-- supabase/rls-checks/fees.sql checks it.

do $$
declare
  f record;
  def text;
begin
  for f in
    select * from (values
      ('record_payment(uuid,bigint,payment_method,text,uuid)',
       'raise exception ''Enter the amount received.'' using errcode = ''22023'';',
       $add$
  if p_amount_cents % 100 <> 0 and p_amount_cents <> inv.total_cents - inv.paid_cents then
    raise exception 'Payments are recorded in whole shillings.' using errcode = '22023';  -- FIG-1334
  end if;$add$),
      ('charge_learner(uuid,bigint,text,uuid)',
       'raise exception ''Enter the amount to charge.'' using errcode = ''22023'';',
       $add$
  if p_amount_cents % 100 <> 0 then
    raise exception 'Charges are in whole shillings.' using errcode = '22023';  -- FIG-1334
  end if;$add$),
      ('adjust_invoice_total(uuid,bigint,text)',
       'raise exception ''Enter the new total.'' using errcode = ''22023'';',
       $add$
  if p_total_cents % 100 <> 0 then
    raise exception 'Totals are in whole shillings.' using errcode = '22023';  -- FIG-1334
  end if;$add$)
    ) v(fn, raise_line, addition)
  loop
    def := pg_get_functiondef(f.fn::regprocedure);
    if def ~ 'FIG-1334' then continue; end if;
    -- the raise line, then its "end if;", whatever the line endings
    if def !~ (regexp_replace(f.raise_line, '([.()|*+?\[\]{}^$\\])', '\\\1', 'g') || '\s*end if;') then
      raise exception '% has changed shape; add the whole-shillings check by hand', f.fn;
    end if;
    def := regexp_replace(def,
      '(' || regexp_replace(f.raise_line, '([.()|*+?\[\]{}^$\\])', '\\\1', 'g') || '\s*end if;)',
      '\1' || replace(f.addition, '\', '\\'));
    if def !~ 'FIG-1334' then
      raise exception 'Could not add the whole-shillings check to %', f.fn;
    end if;
    execute def;
  end loop;
end $$;

alter table fee_items add constraint fee_items_whole_shillings check (amount_cents % 100 = 0) not valid;
