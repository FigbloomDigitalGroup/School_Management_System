-- "Other staff": one account role for everyone at a school who isn't a
-- teacher, an admin or a driver -- the librarian, the matron, the nurse, the
-- cooks, the guard and the receptionist. Their job is a title on the profile,
-- not a role each. A new enum value must be committed before it can be used
-- in another statement, so this is its own migration file, applied before
-- 20261028100001, which moves the gate and reception accounts onto it.
alter type app_role add value 'staff';
