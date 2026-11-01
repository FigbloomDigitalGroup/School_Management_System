-- FIG-1295: policies that only make sense for a signed-in user say so.
--
-- A policy created without a TO clause applies to every role, anon
-- included. When it calls a helper whose execute was revoked from anon
-- (may_teach_class_subject, is_guardian_of, may_read_conversation, ...), an
-- anonymous query on that table doesn't come back empty: it fails with
-- "permission denied for function", HTTP 401 from the database API and 403
-- from storage. It fails closed, so nothing was exposed, but it's an error
-- for something that should be a quiet "nothing here", and it stopped
-- supabase/rls-checks/tenant_isolation.sql at its anonymous section.
--
-- QA counted 33 such policies on 2026-10-27 (26 on public tables, 7 on
-- storage.objects) and 8 more since (exam paper excusals and overrides, and
-- the medical tables). Rather than list them by hand, this finds every
-- policy with no TO clause that calls a public or storage function anon
-- can't execute, and limits it to authenticated. For a signed-in user
-- nothing changes; anon already got nothing and now gets it quietly.
-- On a local database at main this altered 41 policies.
--
-- tenant_isolation.sql now fails if a new policy brings the problem back.

do $$
declare
  p record;
begin
  for p in
    select distinct pol.schemaname, pol.tablename, pol.policyname
      from pg_policies pol
      join pg_proc f on f.pronamespace in ('public'::regnamespace, 'storage'::regnamespace)
       and (coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~ ('(^|[^a-z_])' || f.proname || '\(')
       and not has_function_privilege('anon', f.oid, 'EXECUTE')
     where pol.roles = '{public}' and pol.schemaname in ('public', 'storage')
  loop
    execute format('alter policy %I on %I.%I to authenticated', p.policyname, p.schemaname, p.tablename);
    raise notice 'to authenticated: %.% %', p.schemaname, p.tablename, p.policyname;
  end loop;
end $$;
