-- Two front-desk accounts: the guard at the gate and the receptionist at the
-- office. A new enum value must be committed before it can be used in another
-- statement, so these are their own migration file, applied before the
-- visitor tables (20261027010001) that reference them.
alter type app_role add value 'guard';
alter type app_role add value 'receptionist';
