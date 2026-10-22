-- The teacher/parent unread badges and the Notices/Inbox lists were only
-- ever polled every 20s (fleet_realtime's own comment notes it was the
-- first table ever added to supabase_realtime -- nothing else streams).
-- That read as "doesn't update live" to anyone who checked within the
-- window. Streaming inserts lets the badge and list react the moment a
-- reminder/message is sent; polling stays on as a safety net in case an
-- event is ever missed while a tab is backgrounded.
alter publication supabase_realtime add table announcements;
