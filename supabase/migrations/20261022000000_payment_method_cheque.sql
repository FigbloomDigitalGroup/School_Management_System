-- Schools take cheques as well as cash and bank deposits; the bursar records
-- them the same way (record_payment, 20261022000001). An enum value can't be
-- used in the transaction that adds it, so it gets its own migration.
alter type payment_method add value if not exists 'cheque';
