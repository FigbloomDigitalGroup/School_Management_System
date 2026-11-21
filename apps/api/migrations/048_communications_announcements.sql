-- Stage 12 (first slice): school announcements. Forward-only.
--
-- Product knowledge from legacy announcements + audience_reaches (20261026030000) and
-- packages/shared adminAnnouncements. Rebuild identity uses users + school_memberships,
-- learners + class_memberships + guardian_links (not profiles/students/guardians).
--
-- Channels: in_app and push are RETAIN. SMS and email may be selected and stored but are NOT
-- delivered until the owner disposition for announcement SMS/email is decided (ROADMAP Stage 12
-- outstanding; PRODUCT-CAPABILITY-RECONCILIATION risk register). Selecting them does not invent
-- a provider integration.
--
-- Push delivery is enqueued as job type announcement.push (tenant-isolated worker). The worker
-- records a delivery attempt ledger row; FCM/provider wiring remains a later operational slice.

CREATE TABLE communications_announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  author_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  subject       text NOT NULL,
  body          text NOT NULL,
  audience      jsonb NOT NULL DEFAULT '{"kind":"whole_school"}'::jsonb,
  channels      text[] NOT NULL DEFAULT ARRAY['in_app']::text[],
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communications_announcements_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT communications_announcements_subject_chk CHECK (char_length(btrim(subject)) BETWEEN 1 AND 200),
  CONSTRAINT communications_announcements_body_chk CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
  CONSTRAINT communications_announcements_channels_chk CHECK (
    cardinality(channels) >= 1
    AND channels <@ ARRAY['in_app', 'push', 'sms', 'email']::text[]
    AND 'in_app' = ANY (channels)
  ),
  CONSTRAINT communications_announcements_audience_kind_chk CHECK (
    audience ? 'kind'
    AND audience->>'kind' IN ('whole_school', 'role', 'roles', 'user', 'people', 'class', 'form_level')
  )
);
CREATE INDEX communications_announcements_tenant_published_idx
  ON communications_announcements (tenant_id, published_at DESC NULLS LAST, created_at DESC);

CREATE TABLE communications_announcement_reads (
  tenant_id        uuid NOT NULL,
  announcement_id  uuid NOT NULL,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  read_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id),
  CONSTRAINT communications_announcement_reads_ann_fk
    FOREIGN KEY (announcement_id, tenant_id) REFERENCES communications_announcements (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX communications_announcement_reads_user_idx
  ON communications_announcement_reads (tenant_id, user_id, read_at DESC);

-- Append-only record that a push (or deferred channel) was attempted for one announcement.
CREATE TABLE communications_announcement_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  announcement_id  uuid NOT NULL,
  channel          text NOT NULL,
  status           text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communications_announcement_deliveries_ann_fk
    FOREIGN KEY (announcement_id, tenant_id) REFERENCES communications_announcements (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT communications_announcement_deliveries_channel_chk CHECK (channel IN ('push', 'sms', 'email')),
  CONSTRAINT communications_announcement_deliveries_status_chk CHECK (status IN ('queued', 'skipped_no_provider', 'failed', 'sent'))
);
CREATE INDEX communications_announcement_deliveries_ann_idx
  ON communications_announcement_deliveries (tenant_id, announcement_id, created_at);

-- Audience membership for the rebuild schema (legacy audience_reaches, adapted).
-- Class/form_level reach for parent/student accounts requires learner↔guardian account
-- linking (not yet on directory tables). Those kinds are stored and validated on write; visibility
-- for linked accounts is introduced when identity provisioning attaches users. Until then only
-- whole_school / role / roles / user / people resolve for non-authors.
CREATE FUNCTION public.communications_audience_reaches(p_tenant uuid, p_audience jsonb, p_user uuid) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_role text;
  v_kind text := p_audience->>'kind';
BEGIN
  IF p_audience IS NULL OR p_user IS NULL OR p_tenant IS NULL THEN
    RETURN false;
  END IF;
  SELECT m.role::text INTO v_role
    FROM public.school_memberships m
   WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.archived_at IS NULL
   LIMIT 1;
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF v_kind = 'whole_school' THEN RETURN true; END IF;
  IF v_kind = 'role' THEN RETURN p_audience->>'role' = v_role; END IF;
  IF v_kind = 'roles' THEN
    RETURN jsonb_typeof(p_audience->'roles') = 'array' AND (p_audience->'roles') ? v_role;
  END IF;
  IF v_kind = 'user' THEN RETURN p_audience->>'user_id' = p_user::text; END IF;
  IF v_kind = 'people' THEN
    RETURN jsonb_typeof(p_audience->'profile_ids') = 'array' AND (p_audience->'profile_ids') ? p_user::text;
  END IF;
  -- class / form_level: shape allowed; account-linked reach deferred (no learner/guardian user_id yet).
  IF v_kind IN ('class', 'form_level') THEN
    RETURN false;
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.communications_audience_reaches(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.communications_audience_reaches(uuid, jsonb, uuid) TO figbloom_app;

CREATE FUNCTION public.communications_announcements_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.author_id IS DISTINCT FROM OLD.author_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'announcement identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.published_at IS NOT NULL AND (
         NEW.subject IS DISTINCT FROM OLD.subject
      OR NEW.body IS DISTINCT FROM OLD.body
      OR NEW.audience IS DISTINCT FROM OLD.audience
      OR NEW.channels IS DISTINCT FROM OLD.channels
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
    ) THEN
      RAISE EXCEPTION 'a published announcement is final' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.subject := btrim(NEW.subject);
  NEW.body := btrim(NEW.body);
  RETURN NEW;
END;
$$;
CREATE TRIGGER communications_announcements_guard BEFORE INSERT OR UPDATE ON communications_announcements
  FOR EACH ROW EXECUTE FUNCTION public.communications_announcements_guard();
REVOKE ALL ON FUNCTION public.communications_announcements_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.communications_announcements_guard() FROM figbloom_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'communications_announcements',
    'communications_announcement_reads',
    'communications_announcement_deliveries'
  ]
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

GRANT SELECT, INSERT ON communications_announcements TO figbloom_app;
GRANT UPDATE (subject, body, audience, channels, published_at) ON communications_announcements TO figbloom_app;
GRANT SELECT, INSERT ON communications_announcement_reads TO figbloom_app;
GRANT SELECT, INSERT ON communications_announcement_deliveries TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON communications_announcements FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON communications_announcement_reads FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON communications_announcement_deliveries FROM figbloom_app;

-- Worker may record push delivery outcomes for leased announcement.push jobs (SELECT announcement + INSERT delivery).
GRANT SELECT ON communications_announcements TO figbloom_worker;
GRANT SELECT, INSERT ON communications_announcement_deliveries TO figbloom_worker;
CREATE POLICY communications_announcements_worker ON communications_announcements FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY communications_announcement_deliveries_worker ON communications_announcement_deliveries FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
