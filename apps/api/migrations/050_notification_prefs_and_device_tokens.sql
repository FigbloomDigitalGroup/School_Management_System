-- Stage 12: notification preferences + device tokens (legacy FIG-872 / FIG-293). Forward-only.
-- Rebuild identity: user_id (not profile_id). Push send remains a later FCM slice;
-- tokens and prefs are persisted so clients can register without inventing a vendor.

INSERT INTO permissions (code, description) VALUES
  ('resource.announcement.read', 'List and read school announcements (composer)'),
  ('resource.announcement.write', 'Create and publish school announcements'),
  ('resource.visitor.read', 'Read the gate/reception visitor log'),
  ('resource.visitor.write', 'Record and advance visitor log entries'),
  ('resource.medical.read', 'Read sick bay visits and medical notices'),
  ('resource.medical.write', 'Create and update sick bay visits and medical settings')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.announcement.read'),
  ('school_admin', 'resource.announcement.write'),
  ('school_admin', 'resource.visitor.read'),
  ('school_admin', 'resource.visitor.write'),
  ('school_admin', 'resource.medical.read'),
  ('school_admin', 'resource.medical.write')
ON CONFLICT DO NOTHING;

CREATE TABLE notification_preferences (
  user_id            uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  fee_reminders      boolean NOT NULL DEFAULT true,
  absence_today      boolean NOT NULL DEFAULT true,
  results_published  boolean NOT NULL DEFAULT true,
  general_notices    boolean NOT NULL DEFAULT false,
  chat_messages      boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token       text NOT NULL,
  platform    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_tokens_token_uniq UNIQUE (token),
  CONSTRAINT device_tokens_platform_chk CHECK (platform IN ('android', 'ios')),
  CONSTRAINT device_tokens_token_len CHECK (char_length(token) BETWEEN 16 AND 512)
);
CREATE INDEX device_tokens_user_idx ON device_tokens (user_id);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens FORCE ROW LEVEL SECURITY;

-- Own-row only (session GUC). Tenant-scoped school data is not involved.
CREATE POLICY notification_preferences_own ON notification_preferences FOR ALL TO figbloom_app
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
CREATE POLICY device_tokens_own ON device_tokens FOR ALL TO figbloom_app
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

CREATE POLICY notification_preferences_owner ON notification_preferences FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notification_preferences'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notification_preferences'));
CREATE POLICY device_tokens_owner ON device_tokens FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'device_tokens'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'device_tokens'));

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO figbloom_app;
GRANT SELECT, INSERT, DELETE ON device_tokens TO figbloom_app;
-- Reclaim: upsert deletes then inserts or updates via DELETE+INSERT; platform/token replace uses DELETE.
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON device_tokens FROM figbloom_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON notification_preferences FROM figbloom_app;
