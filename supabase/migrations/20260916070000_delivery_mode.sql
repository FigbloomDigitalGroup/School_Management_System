-- FIG-365 (FIG-358 v1): descriptive delivery mode + real nav/route gating
-- for Fleet/Bus (FIG-366). Attendance/timetable semantics are unchanged —
-- an online tenant still uses roll-call attendance and a fixed weekly grid,
-- explicitly deferred in FIG-358 as future work.
create type delivery_mode as enum ('in_person', 'online', 'hybrid');
alter table tenants add column delivery_mode delivery_mode not null default 'in_person';
