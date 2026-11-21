-- Stage 12: text chat (legacy 20261027020000 + may_talk from 20261028200000). Forward-only.
-- Rebuild: school_memberships roles; learners without user accounts cannot pair as children yet
-- (parent↔learner and parent↔teacher of child deferred until identity provisioning).
-- File attachments deferred (object storage). LiveKit/calls are a separate slice.
-- Push delivery for new messages is not wired (FCM later); messages persist in DB.

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pair_key        text NOT NULL,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CONSTRAINT conversations_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT conversations_pair_uniq UNIQUE (tenant_id, pair_key),
  CONSTRAINT conversations_pair_key_chk CHECK (pair_key ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$')
);
CREATE INDEX conversations_tenant_last_idx ON conversations (tenant_id, last_message_at DESC NULLS LAST);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL,
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT conversation_members_conv_fk FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES conversations (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX conversation_members_user_idx ON conversation_members (tenant_id, user_id);

CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sender_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_conv_fk FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES conversations (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT chat_messages_body_chk CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000)
);
CREATE INDEX chat_messages_conv_time_idx ON chat_messages (conversation_id, created_at);

-- One pairing rule (legacy may_talk), adapted to school_memberships.
-- Parent↔learner / parent↔teacher of child: false until learner/guardian user linking exists.
CREATE FUNCTION public.may_talk(p_tenant uuid, p_a uuid, p_b uuid) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_role_a text;
  v_role_b text;
  v_parent uuid;
  v_other uuid;
  v_role text;
BEGIN
  IF p_tenant IS NULL OR p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN
    RETURN false;
  END IF;
  SELECT m.role::text INTO v_role_a
    FROM public.school_memberships m
   WHERE m.tenant_id = p_tenant AND m.user_id = p_a AND m.archived_at IS NULL;
  SELECT m.role::text INTO v_role_b
    FROM public.school_memberships m
   WHERE m.tenant_id = p_tenant AND m.user_id = p_b AND m.archived_at IS NULL;
  IF v_role_a IS NULL OR v_role_b IS NULL THEN
    RETURN false;
  END IF;

  -- Staff with staff (office, teachers; driver when present as membership role).
  IF v_role_a IN ('school_admin', 'teacher', 'driver', 'staff')
     AND v_role_b IN ('school_admin', 'teacher', 'driver', 'staff') THEN
    RETURN true;
  END IF;

  IF v_role_a = 'parent' THEN
    v_parent := p_a; v_other := p_b; v_role := v_role_b;
  ELSIF v_role_b = 'parent' THEN
    v_parent := p_b; v_other := p_a; v_role := v_role_a;
  ELSE
    RETURN false;
  END IF;

  -- Parent <-> office
  IF v_role = 'school_admin' THEN
    RETURN true;
  END IF;

  -- Parent <-> child / teacher-of-child: deferred (no learner.user_id linking yet).
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.may_talk(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.may_talk(uuid, uuid, uuid) TO figbloom_app;

CREATE FUNCTION public.chat_pair_key(p_a uuid, p_b uuid) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p_a::text < p_b::text THEN p_a::text || ':' || p_b::text ELSE p_b::text || ':' || p_a::text END;
$$;
REVOKE ALL ON FUNCTION public.chat_pair_key(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_pair_key(uuid, uuid) TO figbloom_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations', 'conversation_members', 'chat_messages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t
    );
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON conversations TO figbloom_app;
GRANT SELECT, INSERT, UPDATE ON conversation_members TO figbloom_app;
GRANT SELECT, INSERT ON chat_messages TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON conversations FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON conversation_members FROM figbloom_app;
REVOKE DELETE, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON chat_messages FROM figbloom_app;
