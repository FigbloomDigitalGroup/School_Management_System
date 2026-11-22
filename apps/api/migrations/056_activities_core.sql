-- Stage 13: activities core (legacy 20261027070000) — clubs + patrons + members. Forward-only.
-- Events/participants follow in a later migration if needed; push notify deferred.

INSERT INTO permissions (code, description) VALUES
  ('resource.activity.read', 'Read activities and membership'),
  ('resource.activity.write', 'Manage activities, patrons and members')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.activity.read'),
  ('school_admin', 'resource.activity.write')
ON CONFLICT DO NOTHING;

CREATE TABLE activities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name             text NOT NULL,
  category         text NOT NULL,
  description      text NOT NULL DEFAULT '',
  meeting_schedule text NOT NULL DEFAULT '',
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activities_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT activities_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT activities_category_chk CHECK (category IN ('sport', 'club', 'arts', 'other')),
  CONSTRAINT activities_description_chk CHECK (char_length(description) <= 2000),
  CONSTRAINT activities_schedule_chk CHECK (char_length(meeting_schedule) <= 300)
);
CREATE UNIQUE INDEX activities_tenant_name ON activities (tenant_id, lower(btrim(name)));

CREATE TABLE activity_patrons (
  activity_id uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  teacher_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, teacher_user_id),
  CONSTRAINT activity_patrons_activity_fk FOREIGN KEY (activity_id, tenant_id) REFERENCES activities (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX activity_patrons_teacher_idx ON activity_patrons (tenant_id, teacher_user_id);

CREATE TABLE activity_members (
  activity_id uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  learner_id  uuid NOT NULL,
  role        text,
  joined_on   date NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (activity_id, learner_id),
  CONSTRAINT activity_members_activity_fk FOREIGN KEY (activity_id, tenant_id) REFERENCES activities (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT activity_members_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT activity_members_role_chk CHECK (role IS NULL OR char_length(btrim(role)) BETWEEN 1 AND 60)
);
CREATE INDEX activity_members_learner_idx ON activity_members (tenant_id, learner_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activities', 'activity_patrons', 'activity_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON activities TO figbloom_app;
GRANT UPDATE (name, category, description, meeting_schedule, active) ON activities TO figbloom_app;
GRANT SELECT, INSERT, DELETE ON activity_patrons TO figbloom_app;
GRANT SELECT, INSERT, DELETE ON activity_members TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON activities FROM figbloom_app;
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON activity_patrons FROM figbloom_app;
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON activity_members FROM figbloom_app;
