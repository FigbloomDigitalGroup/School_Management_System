-- Payment proof pasted as text.
--
-- Most families pay by M-Pesa and get the proof as an SMS, so "upload a
-- photo of it" meant screenshotting a text message. A proof can now be the
-- confirmation SMS itself, pasted in, with or without a file. The parent's
-- browser parses it (packages/shared/src/paymentSms.ts) and sends what it
-- read alongside the raw text; the bursar sees both and checks the code
-- against the school's own statement before recording the payment through
-- record_payment(), exactly as for an uploaded slip.
--
-- The database adds the one check that can't be left to the browser: a
-- transaction code is used once per school. Re-pasting an old SMS (yours or
-- someone else's) is the classic fake proof, so a code already on another
-- live proof, or already on a recorded payment, is refused. A rejected proof
-- frees its code: the usual reason is "wrong child" or "wrong amount typed",
-- and the family resubmits the same SMS. The code must also appear in the
-- pasted text, so the parsed fields can't claim a code the SMS doesn't show.
--
-- Amount and paybill mismatches are only flagged (in the office's queue):
-- part payments are real, and some schools bank through a bank's paybill.
--
-- Nothing here asks Safaricom whether the code is real; that needs Daraja's
-- transaction-status API per school, a later step.

alter table payment_proofs
  alter column file_path drop not null,
  alter column file_name drop not null,
  add column sms_text          text check (sms_text is null or char_length(sms_text) between 10 and 2000),
  add column txn_source        text check (txn_source in ('mpesa', 'airtel', 'bank', 'unknown')),
  add column txn_code          text check (txn_code is null or txn_code ~ '^[A-Z0-9][A-Z0-9.-]{3,40}$'),
  add column txn_amount_cents  bigint check (txn_amount_cents is null or txn_amount_cents > 0),
  add column txn_at            timestamptz,
  add column txn_payee         text check (txn_payee is null or char_length(txn_payee) <= 80),
  add column txn_payee_number  text check (txn_payee_number is null or txn_payee_number ~ '^\+?[0-9]{5,13}$'),
  add column txn_account       text check (txn_account is null or char_length(txn_account) <= 40),
  -- why the office turned it down, shown to the family
  add column rejection_reason  text check (rejection_reason is null or char_length(rejection_reason) <= 300),
  add constraint payment_proofs_file_pair check ((file_path is null) = (file_name is null)),
  add constraint payment_proofs_has_evidence check (file_path is not null or sms_text is not null),
  add constraint payment_proofs_sms_has_code check (sms_text is null or txn_code is not null);

-- One live proof per transaction code per school. The trigger below gives
-- the friendly message; this is the backstop for two submissions racing.
create unique index payment_proofs_live_txn_code on payment_proofs (tenant_id, txn_code)
  where txn_code is not null and status <> 'rejected';

-- Security definer: the duplicate check has to see every proof and payment
-- in the school, not only the ones the family submitting can read.
create or replace function payment_proofs_check_sms() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  NEW.txn_code := nullif(upper(trim(NEW.txn_code)), '');
  NEW.sms_text := nullif(trim(NEW.sms_text), '');

  -- A family submits a proof; only the office reviews one.
  if TG_OP = 'INSERT' and not (is_super() or (NEW.tenant_id = my_tenant() and is_staff()) or may_administer(NEW.tenant_id)) then
    NEW.reviewed_by := null;
    NEW.reviewed_at := null;
    NEW.rejection_reason := null;
  end if;

  -- Checked when a code arrives or a rejected proof comes back to life; not
  -- when record_payment() confirms it, by which time its own payment exists.
  if NEW.txn_code is null
     or (TG_OP = 'UPDATE' and NEW.txn_code is not distinct from OLD.txn_code
         and NEW.sms_text is not distinct from OLD.sms_text
         and not (OLD.status = 'rejected' and NEW.status <> 'rejected')) then
    return NEW;
  end if;

  if NEW.sms_text is not null and position(NEW.txn_code in upper(NEW.sms_text)) = 0 then
    raise exception 'The transaction code % is not in the pasted message.', NEW.txn_code using errcode = '22023';
  end if;

  if NEW.status <> 'rejected' and exists (
    select 1 from payment_proofs p
    where p.tenant_id = NEW.tenant_id and p.txn_code = NEW.txn_code and p.status <> 'rejected' and p.id <> NEW.id
  ) then
    raise exception 'Transaction % has already been sent to the school as proof.', NEW.txn_code using errcode = '23505';
  end if;

  if exists (
    select 1 from payments p
    where p.tenant_id = NEW.tenant_id and p.status = 'success'
      and (upper(p.mpesa_receipt) = NEW.txn_code or upper(p.reference) = NEW.txn_code)
  ) then
    raise exception 'Transaction % has already been recorded as a payment.', NEW.txn_code using errcode = '23505';
  end if;

  return NEW;
end;
$$;

create trigger payment_proofs_check_sms before insert or update of txn_code, sms_text, status on payment_proofs
  for each row execute function payment_proofs_check_sms();
