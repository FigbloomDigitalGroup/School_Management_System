-- Stage 12–13 catalogue hardening. Forward-only.
-- Align grants with Stage 9/10 least-privilege: no table-level UPDATE/DELETE on tenant tables;
-- medical_* UPDATE becomes column-level; junction DELETE revoked (no hard-delete API yet).

REVOKE UPDATE ON medical_settings FROM figbloom_app;
GRANT UPDATE (notify_guardians, updated_at, updated_by) ON medical_settings TO figbloom_app;

REVOKE UPDATE ON medical_notices FROM figbloom_app;
GRANT UPDATE (read_at) ON medical_notices TO figbloom_app;

REVOKE DELETE ON activity_patrons FROM figbloom_app;
REVOKE DELETE ON activity_members FROM figbloom_app;
REVOKE DELETE ON route_stops FROM figbloom_app;
REVOKE DELETE ON learner_transport FROM figbloom_app;

-- User-scoped prefs/tokens: keep reclaim DELETE on device_tokens; column-level UPDATE on prefs.
REVOKE UPDATE ON notification_preferences FROM figbloom_app;
GRANT UPDATE (
  fee_reminders, absence_today, results_published, general_notices, chat_messages, updated_at
) ON notification_preferences TO figbloom_app;

-- Chat: column-level UPDATE only.
REVOKE UPDATE ON conversations FROM figbloom_app;
GRANT UPDATE (last_message_at) ON conversations TO figbloom_app;
REVOKE UPDATE ON conversation_members FROM figbloom_app;
GRANT UPDATE (last_read_at) ON conversation_members TO figbloom_app;
