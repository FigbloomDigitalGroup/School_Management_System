-- FIG-397 (root of the FIG-396 epic): a short, school-assigned alphanumeric
-- ID (e.g. "TC-0001" for a teacher, "PT-0029" for a parent, "ST-0009" for a
-- student, "BD-0099" for a driver) is becoming the sign-in credential for
-- every non-org-owner role -- replacing real email for school_admin/
-- teacher/driver, phone+SMS-OTP for parents, and the bare admission number
-- for students. org_admin/super_admin are unaffected and keep real email.
--
-- Scoped the same way students.admission_no already is: unique together
-- with tenant_id, not unique alone -- two different schools can each assign
-- their own "TC-0001" (schema.sql:81-93's unique (tenant_id, admission_no)
-- is the direct precedent this mirrors). Nullable because org_admin/
-- super_admin never get one (their profiles.tenant_id is always null too,
-- per the existing tenant_required check), and a composite unique
-- constraint treats every null pair as distinct, so that's never a clash.

alter table profiles add column login_id text;
alter table profiles add constraint profiles_login_id_unique unique (tenant_id, login_id);
