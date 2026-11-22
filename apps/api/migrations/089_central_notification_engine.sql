-- Stage 2: Central Notification Engine (transactional outbox, in-app notifications,
-- delivery attempt tracking, device revocation, worker dispatch). Forward-only.

-- 1. Extend jobs_type_chk to include notification.dispatch
ALTER TABLE jobs DROP CONSTRAINT jobs_type_chk;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_chk
  CHECK (job_type IN ('mpesa.stk_settle', 'announcement.push', 'notification.dispatch'));

-- 2. Operational visibility permission for school/platform administrators
INSERT INTO permissions (code, description) VALUES
  ('resource.notifications.admin', 'Inspect notification outbox and delivery attempts for the school')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.notifications.admin'),
  ('super_admin', 'resource.notifications.admin')
ON CONFLICT DO NOTHING;

-- 3. Device token revocation + rotation tracking (no revoked device may receive future push messages)
ALTER TABLE device_tokens
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_reason text,
  ADD COLUMN rotated_from_id uuid REFERENCES device_tokens (id) ON DELETE SET NULL;

ALTER TABLE device_tokens
  ADD CONSTRAINT device_tokens_revoked_reason_len
    CHECK (revoked_reason IS NULL OR char_length(revoked_reason) BETWEEN 1 AND 120);

CREATE INDEX device_tokens_active_user_idx ON device_tokens (user_id) WHERE revoked_at IS NULL;

-- Revoke own device token (figbloom_app, bound to app_current_user_id())
CREATE FUNCTION public.device_tokens_revoke(p_token_id uuid, p_reason text DEFAULT 'user_revoked')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid := public.app_current_user_id();
  v_reason text := COALESCE(NULLIF(btrim(p_reason), ''), 'user_revoked');
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'user context required' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) > 120 THEN
    v_reason := left(v_reason, 120);
  END IF;
  UPDATE public.device_tokens
     SET revoked_at = now(),
         revoked_reason = v_reason
   WHERE id = p_token_id
     AND user_id = v_uid
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
    VALUES ('notifications.device.revoked', v_uid, NULL, jsonb_build_object('deviceTokenId', p_token_id, 'reason', v_reason));
  END IF;
  RETURN v_count > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.device_tokens_revoke(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.device_tokens_revoke(uuid, text) TO figbloom_app;

-- Worker-only: mark an expired/unregistered push token as revoked without exposing raw tokens to the API
CREATE FUNCTION public.device_tokens_mark_invalid(p_token_id uuid, p_reason text DEFAULT 'invalid_token')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_reason text := COALESCE(NULLIF(btrim(p_reason), ''), 'invalid_token');
  v_count integer;
BEGIN
  IF char_length(v_reason) > 120 THEN
    v_reason := left(v_reason, 120);
  END IF;
  UPDATE public.device_tokens
     SET revoked_at = now(),
         revoked_reason = v_reason
   WHERE id = p_token_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.device_tokens_mark_invalid(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.device_tokens_mark_invalid(uuid, text) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.device_tokens_mark_invalid(uuid, text) TO figbloom_worker;

-- Worker-only: resolve active non-revoked device tokens for recipients who belong to the current tenant
CREATE FUNCTION public.notification_worker_active_devices(p_user_ids uuid[])
RETURNS TABLE (id uuid, user_id uuid, token text, platform text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT dt.id, dt.user_id, dt.token, dt.platform
    FROM public.device_tokens dt
    JOIN public.school_memberships sm
      ON sm.user_id = dt.user_id
     AND sm.tenant_id = public.app_current_tenant_id()
     AND sm.archived_at IS NULL
    JOIN public.users u
      ON u.id = dt.user_id
     AND u.status = 'active'
   WHERE dt.user_id = ANY (p_user_ids)
     AND dt.revoked_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.notification_worker_active_devices(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_worker_active_devices(uuid[]) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.notification_worker_active_devices(uuid[]) TO figbloom_worker;

-- Worker-only: resolve active recipients (valid active members of the current tenant) and their notification prefs
CREATE FUNCTION public.notification_worker_resolve_recipients(p_user_ids uuid[])
RETURNS TABLE (
  user_id uuid,
  fee_reminders boolean,
  absence_today boolean,
  results_published boolean,
  general_notices boolean,
  chat_messages boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT sm.user_id,
         COALESCE(np.fee_reminders, true) AS fee_reminders,
         COALESCE(np.absence_today, true) AS absence_today,
         COALESCE(np.results_published, true) AS results_published,
         COALESCE(np.general_notices, false) AS general_notices,
         COALESCE(np.chat_messages, true) AS chat_messages
    FROM public.school_memberships sm
    JOIN public.users u
      ON u.id = sm.user_id
     AND u.status = 'active'
    LEFT JOIN public.notification_preferences np
      ON np.user_id = sm.user_id
   WHERE sm.tenant_id = public.app_current_tenant_id()
     AND sm.archived_at IS NULL
     AND sm.user_id = ANY (p_user_ids);
$$;
REVOKE ALL ON FUNCTION public.notification_worker_resolve_recipients(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_worker_resolve_recipients(uuid[]) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.notification_worker_resolve_recipients(uuid[]) TO figbloom_worker;

-- 4. Transactional outbox table
CREATE TABLE notification_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  event_type         text NOT NULL,
  category           text NOT NULL,
  idempotency_key    text NOT NULL,
  recipient_user_ids uuid[] NOT NULL,
  title              text NOT NULL,
  body               text NOT NULL,
  channels           text[] NOT NULL DEFAULT ARRAY['in_app', 'push'],
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'queued',
  attempts           integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 5,
  last_error_code    text,
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  CONSTRAINT notification_outbox_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT notification_outbox_idempotency_uniq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT notification_outbox_category_chk CHECK (
    category IN ('transport', 'medication', 'finance', 'attendance', 'academics', 'announcement', 'general')
  ),
  CONSTRAINT notification_outbox_status_chk CHECK (
    status IN ('queued', 'processing', 'completed', 'partial', 'failed', 'dead')
  ),
  CONSTRAINT notification_outbox_event_len CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 120),
  CONSTRAINT notification_outbox_key_len CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  CONSTRAINT notification_outbox_title_len CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT notification_outbox_body_len CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  CONSTRAINT notification_outbox_channels_chk CHECK (
    cardinality(channels) >= 1 AND channels <@ ARRAY['in_app', 'push', 'sms', 'email']::text[]
  ),
  CONSTRAINT notification_outbox_recipients_chk CHECK (cardinality(recipient_user_ids) BETWEEN 1 AND 500),
  CONSTRAINT notification_outbox_attempts_chk CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT notification_outbox_meta_obj CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX notification_outbox_tenant_status_idx ON notification_outbox (tenant_id, status, created_at DESC, id);

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_outbox_tenant ON notification_outbox FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY notification_outbox_worker ON notification_outbox FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY notification_outbox_owner ON notification_outbox FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notification_outbox'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notification_outbox'));

GRANT SELECT, INSERT ON notification_outbox TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON notification_outbox FROM figbloom_app;
GRANT SELECT ON notification_outbox TO figbloom_worker;
GRANT UPDATE (status, attempts, last_error_code, processed_at) ON notification_outbox TO figbloom_worker;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON notification_outbox FROM figbloom_worker;

-- 5. Central in-app notifications table (strictly tenant + own-recipient isolated for figbloom_app)
CREATE TABLE notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  outbox_id         uuid,
  recipient_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category          text NOT NULL,
  event_type        text NOT NULL,
  title             text NOT NULL,
  body              text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_event_key  text NOT NULL,
  read_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT notifications_outbox_fk FOREIGN KEY (outbox_id, tenant_id) REFERENCES notification_outbox (id, tenant_id) ON DELETE SET NULL (outbox_id),
  CONSTRAINT notifications_dedupe UNIQUE (tenant_id, recipient_user_id, source_event_key),
  CONSTRAINT notifications_category_chk CHECK (
    category IN ('transport', 'medication', 'finance', 'attendance', 'academics', 'announcement', 'general')
  ),
  CONSTRAINT notifications_title_len CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT notifications_body_len CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  CONSTRAINT notifications_source_key_len CHECK (char_length(btrim(source_event_key)) BETWEEN 1 AND 240),
  CONSTRAINT notifications_meta_obj CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX notifications_recipient_idx ON notifications (tenant_id, recipient_user_id, created_at DESC, id);
CREATE INDEX notifications_unread_idx ON notifications (tenant_id, recipient_user_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_tenant ON notifications FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY notifications_own_recipient ON notifications AS RESTRICTIVE FOR ALL TO figbloom_app
  USING (recipient_user_id = app_current_user_id()) WITH CHECK (recipient_user_id = app_current_user_id());
CREATE POLICY notifications_worker ON notifications FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY notifications_owner ON notifications FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notifications'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notifications'));

-- Users can only read their own notifications and mark them read; creation happens via worker/outbox
GRANT SELECT ON notifications TO figbloom_app;
GRANT UPDATE (read_at) ON notifications TO figbloom_app;
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON notifications FROM figbloom_app;
GRANT SELECT, INSERT ON notifications TO figbloom_worker;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON notifications FROM figbloom_worker;

-- 6. Delivery attempt tracking table (operational visibility + idempotent retry tracking)
CREATE TABLE notification_delivery_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  outbox_id           uuid NOT NULL,
  notification_id     uuid,
  recipient_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel             text NOT NULL,
  provider            text NOT NULL,
  device_token_id     uuid,
  attempt_number      integer NOT NULL DEFAULT 1,
  status              text NOT NULL,
  provider_message_id text,
  error_code          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_delivery_attempts_outbox_fk FOREIGN KEY (outbox_id, tenant_id) REFERENCES notification_outbox (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT notification_delivery_attempts_notif_fk FOREIGN KEY (notification_id, tenant_id) REFERENCES notifications (id, tenant_id) ON DELETE SET NULL (notification_id),
  CONSTRAINT notification_delivery_attempts_channel_chk CHECK (channel IN ('in_app', 'push', 'sms', 'email')),
  CONSTRAINT notification_delivery_attempts_status_chk CHECK (
    status IN ('delivered', 'failed', 'skipped_preference', 'skipped_revoked', 'not_configured', 'invalid_token', 'invalid_recipient')
  ),
  CONSTRAINT notification_delivery_attempts_attempt_chk CHECK (attempt_number >= 1)
);

CREATE INDEX notification_delivery_attempts_outbox_idx ON notification_delivery_attempts (tenant_id, outbox_id, created_at DESC, id);

ALTER TABLE notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_delivery_attempts_tenant ON notification_delivery_attempts FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY notification_delivery_attempts_worker ON notification_delivery_attempts FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY notification_delivery_attempts_owner ON notification_delivery_attempts FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notification_delivery_attempts'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notification_delivery_attempts'));

GRANT SELECT ON notification_delivery_attempts TO figbloom_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON notification_delivery_attempts FROM figbloom_app;
GRANT SELECT, INSERT ON notification_delivery_attempts TO figbloom_worker;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON notification_delivery_attempts FROM figbloom_worker;
