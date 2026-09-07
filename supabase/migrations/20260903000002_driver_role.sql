-- A new enum value must be committed before it can be used in another
-- statement, so this is its own migration file, applied before the fleet
-- tables that reference it.
alter type app_role add value 'driver';
