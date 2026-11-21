-- Forward-only index cleanup (workstream 4, evidence-based).
-- he_grades_enrolment_idx (032) is column-for-column identical to the UNIQUE index he_grades_current_uidx (035): both are
-- (tenant_id, enrolment_id), neither is partial, so the unique index serves every plan the plain one did (lookups by enrolment,
-- the enrolment foreign-key delete checks) and the plain index only adds write cost and storage. Verified by
-- test/cleanup.indexes.test.ts (EXPLAIN uses the unique index; identical key definition asserted from the catalogue).
-- Other prefix-redundant indexes were reviewed and deliberately kept (see CODE-QUALITY-AUDIT): they back foreign-key delete
-- guards or serve a different predicate, and no evidence supports dropping them.
DROP INDEX IF EXISTS public.he_grades_enrolment_idx;
