-- Acknowledging a bus alert could rewrite the alert (audit F-031).
--
-- vehicle_alerts_ack lets school staff (and the transport area) UPDATE an alert so the office can acknowledge it, but a policy
-- can't limit columns: a teacher could change what the alert says happened (kind, detail), where (lat, lng), when (created_at),
-- or which bus, and acknowledged_by was whatever the app sent, so an alert could be acknowledged in someone else's name.
--
-- A trigger now lets a signed-in user change nothing about an alert except acknowledging it, and the database records who and
-- when: acknowledged_by is the caller and acknowledged_at is now(), whatever the request said. An alert already acknowledged
-- keeps its first acknowledgement (two people clicking at once don't overwrite each other). It compares whole rows, so a column
-- added later is protected by default. The service role (the alert triggers, bus-tick, seeds) is unaffected.

create or replace function guard_vehicle_alert_ack() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;

  if (to_jsonb(new) - 'acknowledged_at' - 'acknowledged_by')
     is distinct from (to_jsonb(old) - 'acknowledged_at' - 'acknowledged_by') then
    raise exception 'An alert can only be acknowledged, not changed.' using errcode = '42501';
  end if;

  if old.acknowledged_at is not null then return old; end if;
  if new.acknowledged_at is null then
    raise exception 'An alert can only be acknowledged, not un-acknowledged.' using errcode = '42501';
  end if;

  new.acknowledged_at := now();
  new.acknowledged_by := auth.uid();
  return new;
end $$;

create trigger vehicle_alerts_guard_ack before update on vehicle_alerts
  for each row execute function guard_vehicle_alert_ack();
