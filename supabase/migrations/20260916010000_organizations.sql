-- FIG-331 (part 1 of 2): the new app_role value must land in its own
-- migration/transaction — Postgres forbids using a freshly-added enum value
-- in the same transaction that added it (e.g. in a check constraint), so the
-- rest of this ticket's schema is in the next migration file.
alter type app_role add value 'org_admin';
