-- 107: a higher-education section has an instructor. Forward-only; 001-106 untouched (106 is held by another open slice).
-- Design: docs/TEACHER-READS.md, Part 3.
--
-- Until now a section was a course in a term with a label, so "which sections does this lecturer teach?" could not be
-- answered. The instructor is a staff record of the same school (a lecturer is a staff member with a linked sign-in, as a
-- teacher of a class is). The column is nullable: a section may have none yet, and clearing it puts it back to none.
--
--   * Same-school is a DATABASE rule, not only an application check: the foreign key is on (instructor_staff_id, tenant_id)
--     and staff_members has UNIQUE (id, tenant_id) (018), so a staff id of another school cannot be stored even by a bug.
--     A NULL instructor is not checked (MATCH SIMPLE), as a class with no class teacher is not.
--   * RESTRICT, as teaching_assignments_staff_fk (029): staff are archived, never deleted, and a section never silently
--     loses its instructor.
--   * No new table, policy or SECURITY DEFINER function: he_sections already has ENABLE + FORCE row security, the tenant
--     policy and the owner policy (032). INSERT is table-level since 032, so the new column is insertable already.
--     UPDATE stays column-level (test/grants.matrix.test.ts): only this column, never the course, the term, the label,
--     the identity or the provenance of a section.

ALTER TABLE he_sections
  ADD COLUMN instructor_staff_id uuid,
  ADD CONSTRAINT he_sections_instructor_fk
    FOREIGN KEY (instructor_staff_id, tenant_id)
    REFERENCES staff_members (id, tenant_id)
    ON DELETE RESTRICT;

-- "The sections one instructor teaches" (GET /me/teaching/he-sections) and the restrict check above.
CREATE INDEX he_sections_instructor_idx
  ON he_sections (tenant_id, instructor_staff_id)
  WHERE instructor_staff_id IS NOT NULL;

GRANT UPDATE (instructor_staff_id) ON he_sections TO figbloom_app;
