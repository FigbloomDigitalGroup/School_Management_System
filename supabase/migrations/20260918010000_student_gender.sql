-- Nothing recorded a learner's gender at all, so nothing could catch a
-- mixed-gender CSV import going into a single-sex school (confirmed live:
-- a boys' school import silently included girls, with no field anywhere
-- to notice or filter on). Nullable so existing rows aren't broken --
-- going forward, both the single "Add a learner" form and CSV import
-- require it.

alter table students add column gender text check (gender in ('male', 'female'));
