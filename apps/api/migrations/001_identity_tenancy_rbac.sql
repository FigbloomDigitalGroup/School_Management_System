-- P1-A / FIG-1573 — Identity, tenancy and RBAC foundation
-- Forward-only. Applied by apps/api migrate against isolated figbloom_api DB.
-- Does not modify the legacy Supabase schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- schema_migrations is owned by the migrate runner (src/db/migrate.ts).

-- ---------------------------------------------------------------- organizations
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  kind text NOT NULL CHECK (kind IN ('government', 'county', 'constituency', 'group_owner')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- tenants (schools)
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  status text NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('active', 'trial', 'onboarding', 'overdue', 'suspended', 'setup_stalled')),
  timezone text NOT NULL DEFAULT 'Africa/Nairobi',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenants_organization_id_idx ON tenants (organization_id);
CREATE INDEX tenants_status_idx ON tenants (status);

-- ---------------------------------------------------------------- users (canonical identity)
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  phone text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'invited')),
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lower CHECK (email IS NULL OR email = lower(email))
);

-- ---------------------------------------------------------------- school memberships
-- Explicit membership is the only proof of school access. Client-supplied
-- tenant IDs are never trusted without a matching membership row.
CREATE TABLE school_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN (
    'school_admin', 'teacher', 'parent', 'student', 'driver', 'staff'
  )),
  login_id text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id),
  CONSTRAINT school_memberships_login_id_format CHECK (
    login_id IS NULL OR login_id ~ '^[A-Z]{2}-[0-9]{4}$'
  )
);
CREATE UNIQUE INDEX school_memberships_tenant_login_id_uidx
  ON school_memberships (tenant_id, lower(login_id))
  WHERE login_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX school_memberships_user_id_idx ON school_memberships (user_id);
CREATE INDEX school_memberships_tenant_role_idx ON school_memberships (tenant_id, role)
  WHERE archived_at IS NULL;

-- ---------------------------------------------------------------- platform roles
CREATE TABLE platform_roles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('super_admin')),
  granted_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- organization memberships
CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'org_admin' CHECK (role IN ('org_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);
CREATE INDEX organization_memberships_org_idx ON organization_memberships (organization_id);

-- ---------------------------------------------------------------- sessions (opaque token hash only)
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  active_tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
  active_organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip inet
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- RBAC catalog
CREATE TABLE permissions (
  code text PRIMARY KEY,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Base role → permission grants. Extensible: later modules INSERT permissions
-- and role_permissions without rewriting the authorization core.
CREATE TABLE role_permissions (
  role text NOT NULL,
  permission_code text NOT NULL REFERENCES permissions (code) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_code)
);

-- Admin areas (parity with legacy has_perm areas including audit)
CREATE TABLE staff_area_grants (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  area text NOT NULL CHECK (area IN (
    'people', 'fees', 'academics', 'attendance', 'transport', 'communication',
    'inventory', 'activities', 'visitors', 'medical', 'leave', 'audit'
  )),
  granted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id, area)
);
CREATE INDEX staff_area_grants_tenant_idx ON staff_area_grants (tenant_id);

CREATE TABLE school_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 60),
  areas text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT school_roles_areas_known CHECK (
    areas <@ ARRAY[
      'people', 'fees', 'academics', 'attendance', 'transport', 'communication',
      'inventory', 'activities', 'visitors', 'medical', 'leave', 'audit'
    ]::text[]
  )
);
CREATE UNIQUE INDEX school_roles_name_unique ON school_roles (tenant_id, lower(trim(name)));

CREATE TABLE school_role_assignments (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES school_roles (id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users (id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX school_role_assignments_role_idx ON school_role_assignments (role_id);
CREATE INDEX school_role_assignments_tenant_idx ON school_role_assignments (tenant_id);

-- ---------------------------------------------------------------- auth rate limit (PG-atomic token bucket)
CREATE TABLE auth_rate_buckets (
  bucket_key text PRIMARY KEY,
  tokens numeric NOT NULL,
  last_refill timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- security audit
CREATE TABLE security_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet
);
CREATE INDEX security_audit_events_tenant_time_idx
  ON security_audit_events (tenant_id, occurred_at DESC);
CREATE INDEX security_audit_events_actor_time_idx
  ON security_audit_events (actor_user_id, occurred_at DESC);
CREATE INDEX security_audit_events_type_time_idx
  ON security_audit_events (event_type, occurred_at DESC);

-- ---------------------------------------------------------------- seed permission catalog
INSERT INTO permissions (code, description) VALUES
  ('identity.self.read', 'Read own identity and memberships'),
  ('identity.self.write', 'Update own non-security profile fields'),
  ('session.manage', 'Create and revoke own sessions'),
  ('tenant.read', 'Read the active school tenant record'),
  ('rbac.permissions.read', 'Read own effective permissions'),
  ('rbac.staff_areas.manage', 'Grant or revoke staff admin areas'),
  ('rbac.school_roles.manage', 'Create and assign custom school roles'),
  ('area.people', 'Admin area: people'),
  ('area.fees', 'Admin area: fees'),
  ('area.academics', 'Admin area: academics'),
  ('area.attendance', 'Admin area: attendance'),
  ('area.transport', 'Admin area: transport'),
  ('area.communication', 'Admin area: communication'),
  ('area.inventory', 'Admin area: inventory'),
  ('area.activities', 'Admin area: activities'),
  ('area.visitors', 'Admin area: visitors'),
  ('area.medical', 'Admin area: medical'),
  ('area.leave', 'Admin area: leave'),
  ('area.audit', 'Admin area: audit log (read)'),
  ('resource.learner.read', 'Representative resource predicate: read learners in tenant'),
  ('platform.tenants.read', 'Platform: list tenants'),
  ('org.tenants.read', 'Organization: read member school summaries');

-- Base grants by school/platform role (least privilege; full admins get areas via mayAdminister)
INSERT INTO role_permissions (role, permission_code) VALUES
  ('super_admin', 'identity.self.read'),
  ('super_admin', 'session.manage'),
  ('super_admin', 'rbac.permissions.read'),
  ('super_admin', 'platform.tenants.read'),
  ('org_admin', 'identity.self.read'),
  ('org_admin', 'session.manage'),
  ('org_admin', 'rbac.permissions.read'),
  ('org_admin', 'org.tenants.read'),
  ('school_admin', 'identity.self.read'),
  ('school_admin', 'identity.self.write'),
  ('school_admin', 'session.manage'),
  ('school_admin', 'tenant.read'),
  ('school_admin', 'rbac.permissions.read'),
  ('school_admin', 'rbac.staff_areas.manage'),
  ('school_admin', 'rbac.school_roles.manage'),
  ('school_admin', 'resource.learner.read'),
  ('teacher', 'identity.self.read'),
  ('teacher', 'identity.self.write'),
  ('teacher', 'session.manage'),
  ('teacher', 'tenant.read'),
  ('teacher', 'rbac.permissions.read'),
  ('staff', 'identity.self.read'),
  ('staff', 'identity.self.write'),
  ('staff', 'session.manage'),
  ('staff', 'tenant.read'),
  ('staff', 'rbac.permissions.read'),
  ('parent', 'identity.self.read'),
  ('parent', 'session.manage'),
  ('parent', 'tenant.read'),
  ('parent', 'rbac.permissions.read'),
  ('student', 'identity.self.read'),
  ('student', 'session.manage'),
  ('student', 'tenant.read'),
  ('student', 'rbac.permissions.read'),
  ('driver', 'identity.self.read'),
  ('driver', 'session.manage'),
  ('driver', 'tenant.read'),
  ('driver', 'rbac.permissions.read');
