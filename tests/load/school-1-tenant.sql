\set ON_ERROR_STOP 1
-- Load test, step 1: the throwaway school, with Alliance's settings. LOCAL DATABASE ONLY.
insert into tenants (name, slug, county, level, plan, status, licensed_seats, institution_type, role_labels, country)
select 'Load Test School', 'load-test', county, level, plan, status, 5000, institution_type, role_labels, country
from tenants where slug = 'alliance'
on conflict (slug) do nothing;
select id, name, slug, status from tenants where slug = 'load-test';
