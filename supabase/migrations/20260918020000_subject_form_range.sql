-- A subject already applies school-wide (one shared list per tenant, not
-- duplicated per class) -- the confusion was that the only place to add one
-- was inside a specific class's Subjects modal, and every subject showed up
-- on every class regardless of whether it's actually offered there (e.g.
-- "Computer" only up to Form 2). Nullable on both ends: no restriction on
-- that side, so an unset subject still applies everywhere, same as before
-- this column existed.

alter table subjects
  add column min_form_level int,
  add column max_form_level int;
