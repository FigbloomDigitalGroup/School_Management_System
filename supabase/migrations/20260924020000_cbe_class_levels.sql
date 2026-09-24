-- CBE, part 1 of 2 (levels): Kenya's CBE runs PP1-PP2 (pre-primary) through
-- Grade 12 (senior school). class_level only covered primary 1-6,
-- junior_secondary 7-9 and 8-4-4 secondary Forms 1-4, so a pre-primary class
-- or a Grade 10-12 senior-school class couldn't be created at all.
--
-- On its own because ALTER TYPE ... ADD VALUE can't be used by a statement in
-- the same transaction that adds it; 20260924030000 uses the new values.
alter type class_level add value if not exists 'pre_primary' before 'primary';
alter type class_level add value if not exists 'senior_school' after 'junior_secondary';
