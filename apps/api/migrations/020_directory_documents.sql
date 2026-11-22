-- Phase 3 — Directory document metadata foundations (FIG-1575)
-- Stores metadata and opaque storage object keys only. No file bytes in PostgreSQL.
-- Upload/download of bytes requires an approved object-storage integration (documented).

INSERT INTO permissions (code, description) VALUES
  ('resource.document.read', 'Read directory document metadata in tenant'),
  ('resource.document.write', 'Register and archive directory document metadata in tenant')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.document.read'),
  ('school_admin', 'resource.document.write')
ON CONFLICT DO NOTHING;

CREATE TABLE directory_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  subject_type text NOT NULL CHECK (subject_type IN ('learner', 'guardian', 'staff')),
  subject_id uuid NOT NULL,
  doc_type text NOT NULL,
  file_name text NOT NULL,
  content_type text,
  byte_size bigint CHECK (byte_size IS NULL OR (byte_size >= 0 AND byte_size <= 104857600)),
  storage_key text NOT NULL,
  uploaded_by uuid REFERENCES users (id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT directory_documents_doc_type_len CHECK (char_length(trim(doc_type)) BETWEEN 1 AND 64),
  CONSTRAINT directory_documents_file_name_len CHECK (char_length(trim(file_name)) BETWEEN 1 AND 255),
  CONSTRAINT directory_documents_content_type_len CHECK (
    content_type IS NULL OR char_length(content_type) BETWEEN 1 AND 128
  ),
  CONSTRAINT directory_documents_storage_key_len CHECK (char_length(storage_key) BETWEEN 1 AND 512),
  -- storage_key must be relative opaque key, not a URL or credential
  CONSTRAINT directory_documents_storage_key_shape CHECK (
    storage_key !~* '^(https?:|s3://|file:)' AND storage_key !~ '\s'
  )
);

CREATE INDEX directory_documents_tenant_subject_idx
  ON directory_documents (tenant_id, subject_type, subject_id)
  WHERE archived_at IS NULL;

CREATE INDEX directory_documents_tenant_created_idx
  ON directory_documents (tenant_id, created_at, id);

ALTER TABLE directory_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY directory_documents_tenant ON directory_documents
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY directory_documents_owner ON directory_documents
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'directory_documents'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'directory_documents'
  ));

GRANT SELECT, INSERT, UPDATE ON directory_documents TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON directory_documents FROM figbloom_app;
