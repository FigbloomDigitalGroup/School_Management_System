-- Stage 3: S3 Object Storage ownership, metadata persistence, lifecycle tracking,
-- server-generated safe object keys, and abandoned upload cleanup. Forward-only.

CREATE TABLE storage_objects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  owner_resource_type text NOT NULL,
  owner_resource_id   uuid,
  uploaded_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  object_key          text NOT NULL,
  original_filename   text NOT NULL,
  content_type        text NOT NULL,
  byte_size           bigint NOT NULL DEFAULT 0,
  checksum_sha256     text,
  storage_provider    text NOT NULL DEFAULT 's3',
  status              text NOT NULL DEFAULT 'pending_upload',
  expires_at          timestamptz,
  deleted_at          timestamptz,
  deleted_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_objects_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT storage_objects_key_uniq UNIQUE (object_key),
  CONSTRAINT storage_objects_owner_type_chk CHECK (
    owner_resource_type IN ('directory_document', 'export_artifact', 'medication_authorization', 'general')
  ),
  CONSTRAINT storage_objects_filename_len CHECK (char_length(btrim(original_filename)) BETWEEN 1 AND 255),
  CONSTRAINT storage_objects_content_type_len CHECK (char_length(btrim(content_type)) BETWEEN 3 AND 128),
  CONSTRAINT storage_objects_size_chk CHECK (byte_size >= 0 AND byte_size <= 104857600),
  CONSTRAINT storage_objects_checksum_chk CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT storage_objects_provider_chk CHECK (storage_provider IN ('s3', 'mock', 'not_configured')),
  CONSTRAINT storage_objects_status_chk CHECK (status IN ('pending_upload', 'available', 'failed', 'deleted'))
);

CREATE INDEX storage_objects_tenant_status_idx ON storage_objects (tenant_id, status, created_at DESC, id);
CREATE INDEX storage_objects_abandoned_idx ON storage_objects (created_at) WHERE status = 'pending_upload';

-- Server-generated safe object key: client can never dictate or collide object keys.
CREATE FUNCTION public.storage_objects_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := gen_random_uuid();
  END IF;
  NEW.object_key := 'tenants/' || NEW.tenant_id::text || '/' || NEW.owner_resource_type || '/' || NEW.id::text;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.storage_objects_before_insert() FROM PUBLIC;

CREATE FUNCTION public.storage_objects_before_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.owner_resource_type, NEW.owner_resource_id, NEW.object_key, NEW.uploaded_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.owner_resource_type, OLD.owner_resource_id, OLD.object_key, OLD.uploaded_by, OLD.created_at) THEN
    RAISE EXCEPTION 'storage object identity and key are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
    RAISE EXCEPTION 'a deleted storage object cannot be restored' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.storage_objects_before_update() FROM PUBLIC;

CREATE TRIGGER storage_objects_before_insert BEFORE INSERT ON storage_objects
  FOR EACH ROW EXECUTE FUNCTION public.storage_objects_before_insert();
CREATE TRIGGER storage_objects_before_update BEFORE UPDATE ON storage_objects
  FOR EACH ROW EXECUTE FUNCTION public.storage_objects_before_update();

ALTER TABLE storage_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_objects FORCE ROW LEVEL SECURITY;

CREATE POLICY storage_objects_tenant ON storage_objects FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY storage_objects_worker ON storage_objects FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY storage_objects_owner ON storage_objects FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'storage_objects'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'storage_objects'));

GRANT SELECT, INSERT ON storage_objects TO figbloom_app;
GRANT UPDATE (status, byte_size, checksum_sha256, deleted_at, deleted_by, updated_at) ON storage_objects TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON storage_objects FROM figbloom_app;

GRANT SELECT, INSERT ON storage_objects TO figbloom_worker;
GRANT UPDATE (status, byte_size, checksum_sha256, deleted_at, updated_at) ON storage_objects TO figbloom_worker;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON storage_objects FROM figbloom_worker;

-- Worker maintenance: mark abandoned pending_upload objects (>24h) as failed and expired artifacts as deleted
CREATE FUNCTION public.worker_cleanup_abandoned_uploads(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_count integer := 0;
  v_exp integer := 0;
BEGIN
  WITH abandoned AS (
    SELECT id FROM public.storage_objects
     WHERE status = 'pending_upload'
       AND created_at < now() - interval '24 hours'
     ORDER BY created_at
     LIMIT v_limit
  )
  UPDATE public.storage_objects so
     SET status = 'failed', updated_at = now()
    FROM abandoned a
   WHERE so.id = a.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  WITH expired AS (
    SELECT id FROM public.storage_objects
     WHERE status = 'available'
       AND expires_at IS NOT NULL
       AND expires_at < now()
     ORDER BY expires_at
     LIMIT v_limit
  )
  UPDATE public.storage_objects so
     SET status = 'deleted', deleted_at = now(), updated_at = now()
    FROM expired e
   WHERE so.id = e.id;
  GET DIAGNOSTICS v_exp = ROW_COUNT;

  RETURN v_count + v_exp;
END;
$$;
REVOKE ALL ON FUNCTION public.worker_cleanup_abandoned_uploads(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.worker_cleanup_abandoned_uploads(integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.worker_cleanup_abandoned_uploads(integer) TO figbloom_worker;
