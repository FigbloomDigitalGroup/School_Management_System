-- FIG-1328: the same bank slip or cheque can't be recorded twice on one invoice.
--
-- record_payment() checked M-Pesa receipts (a unique index), but a bank or
-- cheque reference could be entered twice on the same invoice and was
-- credited twice: two people entering one slip, or one person again after a
-- page reload, made an invoice look paid when nothing more had come in.
--
-- Now a bank or cheque reference that's already on a successful payment of
-- the same invoice is refused, ignoring case and spaces. Other invoices are
-- left alone on purpose: one deposit can be split between brothers.
-- record_payment() locks the invoice row first, so two entries at once are
-- checked one after the other.
--
-- The check is added to the function's current body (20261031000001's,
-- with has_perm), just after the reference is read, rather than copying the
-- whole function here. The migration stops if that line isn't there.
--
-- supabase/rls-checks/fees.sql checks it.

do $$
declare
  def text := pg_get_functiondef('record_payment(uuid,bigint,payment_method,text,uuid)'::regprocedure);
  -- no line ending in the anchor: a body applied from a Windows checkout ends its lines in \r\n
  anchor text := E'  if p_method = ''mpesa'' then ref := upper(ref); end if;';
begin
  if position(anchor in def) = 0 then
    raise exception 'record_payment() has changed shape; add the repeated-reference check by hand';
  end if;
  def := replace(def, anchor, anchor || $add$

  -- the same slip or cheque twice on this invoice (FIG-1328); another invoice may share it
  if p_method in ('bank', 'cheque') and exists (
    select 1 from payments p
     where p.invoice_id = inv.id and p.status = 'success' and p.method = p_method
       and upper(regexp_replace(p.reference, '\s', '', 'g')) = upper(regexp_replace(ref, '\s', '', 'g'))
  ) then
    raise exception 'That % is already recorded on this invoice.',
      case p_method when 'bank' then 'slip' else 'cheque' end using errcode = '23505';
  end if;
$add$);
  execute def;
end $$;
