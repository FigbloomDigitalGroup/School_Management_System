-- Stage 11 remediation, batch 2: an uncertain STK request is never recorded as a provider failure. Forward-only.
--
-- The historical defect (review R2) treated a missing checkout id as proof that a prompt was never sent and
-- failed it with failure_reason 'not_sent'. The application no longer has any code path that does so (the
-- settle job retries; reconciliation flags 'prompt_never_sent'). This trigger makes the rule structural: no runtime
-- role can record a new payment failure with the reason 'not_sent'. The value stays in the
-- failure_reason CHECK list only so that historical rows remain valid.

CREATE FUNCTION public.finance_payments_no_not_sent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'an unacknowledged prompt stays pending: it is never recorded as not sent' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER finance_payments_no_not_sent BEFORE INSERT OR UPDATE ON finance_payments
  FOR EACH ROW WHEN (NEW.failure_reason = 'not_sent')
  EXECUTE FUNCTION public.finance_payments_no_not_sent();
REVOKE ALL ON FUNCTION public.finance_payments_no_not_sent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_payments_no_not_sent() FROM figbloom_app;
