-- Stage 16: deterministic import batch ledger (learner CSV first slice). Forward-only.
-- Fees carry-forward and multi-format extractors are deferred; AI never persists.

INSERT INTO permissions (code, description) VALUES
  ('resource.import.write', 'Preview and apply deterministic school data imports')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.import.write')
ON CONFLICT DO NOTHING;

CREATE TABLE import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'previewed',
  source_name     text NOT NULL DEFAULT 'csv',
  row_count       integer NOT NULL DEFAULT 0,
  valid_count     integer NOT NULL DEFAULT 0,
  error_count     integer NOT NULL DEFAULT 0,
  created_count   integer NOT NULL DEFAULT 0,
  payload_sha256  text NOT NULL,
  preview_json    jsonb NOT NULL,
  created_by      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  applied_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  applied_at      timestamptz,
  CONSTRAINT import_batches_kind_chk CHECK (kind IN ('learners_csv')),
  CONSTRAINT import_batches_status_chk CHECK (status IN ('previewed', 'applied', 'cancelled')),
  CONSTRAINT import_batches_counts_chk CHECK (
    row_count >= 0 AND valid_count >= 0 AND error_count >= 0 AND created_count >= 0
    AND valid_count + error_count = row_count
  ),
  CONSTRAINT import_batches_sha_chk CHECK (char_length(payload_sha256) = 64),
  CONSTRAINT import_batches_applied_chk CHECK (
    (status = 'applied' AND applied_at IS NOT NULL AND applied_by IS NOT NULL)
    OR (status <> 'applied' AND applied_at IS NULL AND applied_by IS NULL)
  )
);
CREATE INDEX import_batches_tenant_idx ON import_batches (tenant_id, created_at DESC);

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY import_batches_tenant ON import_batches FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY import_batches_owner ON import_batches FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'import_batches'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'import_batches'));

GRANT SELECT, INSERT ON import_batches TO figbloom_app;
GRANT UPDATE (status, created_count, applied_by, applied_at) ON import_batches TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON import_batches FROM figbloom_app;
