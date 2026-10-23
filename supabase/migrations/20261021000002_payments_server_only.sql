-- Only mpesa-stk-push creates payments rows.
--
-- payment_insert (20260915010000) let a guardian or student insert their own
-- 'pending' payment against their family's invoice, with any
-- checkout_request_id and amount they liked. Nothing in the apps uses it --
-- mpesa-stk-push writes the row with the service role -- but it handed an
-- attacker a pending payment whose CheckoutRequestID they chose, which was
-- all a forged success callback needed to mark any invoice paid.
-- mpesa-callback now also refuses unsigned callbacks and confirms every
-- result with Daraja; this removes the other half.

drop policy payment_insert on payments;
