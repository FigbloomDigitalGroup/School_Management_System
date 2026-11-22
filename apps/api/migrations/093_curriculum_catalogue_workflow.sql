-- Stage 6: Curriculum Catalogue Import, Provenance, Verification, Rejection & Supersession Workflow.
-- Preserves all 39 existing unverified platform entries untouched. Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('resource.curriculum.verify', 'Import, review, verify, reject and supersede curriculum catalogue entries')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.curriculum.verify'),
  ('super_admin', 'resource.curriculum.verify')
ON CONFLICT DO NOTHING;

-- 1. Import batches table (tenant-scoped, RLS-forced)
CREATE TABLE curriculum_import_batches (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  source_organisation    text NOT NULL,
  source_title           text NOT NULL,
  source_uri             text,
  publication_or_version text,
  retrieved_at           date NOT NULL,
  source_checksum        text,
  imported_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'completed',
  total_rows             integer NOT NULL DEFAULT 0,
  imported_count         integer NOT NULL DEFAULT 0,
  duplicate_count        integer NOT NULL DEFAULT 0,
  error_count            integer NOT NULL DEFAULT 0,
  error_report           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT curr_batch_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT curr_batch_org_len CHECK (char_length(btrim(source_organisation)) BETWEEN 1 AND 120),
  CONSTRAINT curr_batch_title_len CHECK (char_length(btrim(source_title)) BETWEEN 1 AND 200),
  CONSTRAINT curr_batch_status_chk CHECK (status IN ('pending', 'completed', 'failed')),
  CONSTRAINT curr_batch_counts_chk CHECK (total_rows >= 0 AND imported_count >= 0 AND duplicate_count >= 0 AND error_count >= 0),
  CONSTRAINT curr_batch_errors_arr CHECK (jsonb_typeof(error_report) = 'array')
);

CREATE INDEX curr_batch_tenant_idx ON curriculum_import_batches (tenant_id, created_at DESC, id);

ALTER TABLE curriculum_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE curriculum_import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY curr_batch_tenant ON curriculum_import_batches FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY curr_batch_owner ON curriculum_import_batches FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'curriculum_import_batches'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'curriculum_import_batches'));

GRANT SELECT, INSERT ON curriculum_import_batches TO figbloom_app;
GRANT UPDATE (status, total_rows, imported_count, duplicate_count, error_count, error_report) ON curriculum_import_batches TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON curriculum_import_batches FROM figbloom_app;

-- 2. Extend curriculum_reference_entries without modifying any existing rows
ALTER TABLE curriculum_reference_entries
  ADD COLUMN import_batch_id uuid,
  ADD COLUMN reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text,
  ADD COLUMN superseded_by_id uuid REFERENCES curriculum_reference_entries (id) ON DELETE SET NULL,
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN version_number integer NOT NULL DEFAULT 1;

-- Widen verification_status check to include full review/supersession lifecycle while preserving 'unverified' & 'incomplete'
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
    FROM pg_constraint
   WHERE conrelid = 'public.curriculum_reference_entries'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%verification_status%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.curriculum_reference_entries DROP CONSTRAINT %I', v_con);
  END IF;
END
$$;

ALTER TABLE curriculum_reference_entries
  ADD CONSTRAINT curriculum_reference_entries_verification_chk CHECK (
    verification_status IN ('imported', 'unverified', 'under_review', 'verified', 'rejected', 'superseded', 'incomplete')
  );

ALTER TABLE curriculum_reference_entries
  ADD CONSTRAINT curriculum_reference_entries_version_chk CHECK (version_number >= 1);

CREATE INDEX curr_ref_batch_idx ON curriculum_reference_entries (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- 3. Narrow SECURITY DEFINER functions (curriculum_reference_entries stays SELECT-only for figbloom_app)

CREATE FUNCTION public.curriculum_catalogue_import_entry(
  p_batch_id uuid,
  p_provenance_id uuid,
  p_entry_kind text,
  p_code text,
  p_title text,
  p_body text,
  p_education_level text,
  p_grade_band text,
  p_pathway text,
  p_parent_code text,
  p_source_organisation text,
  p_source_title text,
  p_source_uri text,
  p_publication_or_version text,
  p_retrieved_at date,
  p_known_limitations text
) RETURNS TABLE (id uuid, duplicated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_existing uuid;
  v_new_id uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  -- Deterministic duplicate check within tenant by (entry_kind, lower(code)) among non-superseded rows
  SELECT e.id INTO v_existing
    FROM public.curriculum_reference_entries e
   WHERE e.tenant_id = v_tenant
     AND e.entry_kind = p_entry_kind
     AND lower(e.code) = lower(btrim(p_code))
     AND e.verification_status <> 'superseded'
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT v_existing, true;
    RETURN;
  END IF;

  INSERT INTO public.curriculum_reference_entries (
    tenant_id, provenance_id, import_batch_id, entry_kind, code, title, body,
    education_level, grade_band, pathway, parent_code, source_organisation,
    source_title, source_uri, publication_or_version, retrieved_at,
    verification_status, known_limitations, version_number
  ) VALUES (
    v_tenant, p_provenance_id, p_batch_id, p_entry_kind, btrim(p_code), btrim(p_title), p_body,
    p_education_level, p_grade_band, p_pathway, p_parent_code, btrim(p_source_organisation),
    btrim(p_source_title), p_source_uri, p_publication_or_version, p_retrieved_at,
    'imported', p_known_limitations, 1
  )
  RETURNING curriculum_reference_entries.id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, false;
END;
$$;
REVOKE ALL ON FUNCTION public.curriculum_catalogue_import_entry(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.curriculum_catalogue_import_entry(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, date, text) TO figbloom_app;

CREATE FUNCTION public.curriculum_catalogue_transition(
  p_entry_id uuid,
  p_target_status text,
  p_review_note text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_uid uuid := public.app_current_user_id();
  v_is_super boolean;
  v_row public.curriculum_reference_entries%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant and user context required' USING ERRCODE = '42501';
  END IF;
  IF p_target_status NOT IN ('under_review', 'verified', 'rejected') THEN
    RAISE EXCEPTION 'Invalid target verification status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.curriculum_reference_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalogue entry not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.tenant_id IS NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.platform_roles WHERE user_id = v_uid AND role = 'super_admin') INTO v_is_super;
    IF NOT v_is_super THEN
      RAISE EXCEPTION 'Only platform super administrators may review platform catalogue entries' USING ERRCODE = '42501';
    END IF;
  ELSIF v_row.tenant_id IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'Catalogue entry not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.verification_status = 'superseded' THEN
    RAISE EXCEPTION 'A superseded catalogue entry cannot be transitioned' USING ERRCODE = '23514';
  END IF;

  UPDATE public.curriculum_reference_entries
     SET verification_status = p_target_status,
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = NULLIF(btrim(COALESCE(p_review_note, '')), '')
   WHERE id = p_entry_id;

  RETURN p_entry_id;
END;
$$;
REVOKE ALL ON FUNCTION public.curriculum_catalogue_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.curriculum_catalogue_transition(uuid, text, text) TO figbloom_app;

CREATE FUNCTION public.curriculum_catalogue_supersede(
  p_entry_id uuid,
  p_new_title text,
  p_new_body text,
  p_publication_or_version text,
  p_review_note text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_uid uuid := public.app_current_user_id();
  v_is_super boolean;
  v_row public.curriculum_reference_entries%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant and user context required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.curriculum_reference_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalogue entry not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.tenant_id IS NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.platform_roles WHERE user_id = v_uid AND role = 'super_admin') INTO v_is_super;
    IF NOT v_is_super THEN
      RAISE EXCEPTION 'Only platform super administrators may supersede platform catalogue entries' USING ERRCODE = '42501';
    END IF;
  ELSIF v_row.tenant_id IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'Catalogue entry not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.verification_status = 'superseded' THEN
    RAISE EXCEPTION 'Catalogue entry is already superseded' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.curriculum_reference_entries (
    tenant_id, provenance_id, import_batch_id, entry_kind, code, title, body,
    education_level, grade_band, pathway, parent_code, source_organisation,
    source_title, source_uri, source_document_id, publication_or_version, retrieved_at,
    verification_status, known_limitations, version_number, review_note
  ) VALUES (
    v_row.tenant_id, v_row.provenance_id, v_row.import_batch_id, v_row.entry_kind,
    v_row.code || '_v' || (v_row.version_number + 1)::text,
    COALESCE(NULLIF(btrim(p_new_title), ''), v_row.title),
    COALESCE(p_new_body, v_row.body),
    v_row.education_level, v_row.grade_band, v_row.pathway, v_row.parent_code,
    v_row.source_organisation, v_row.source_title, v_row.source_uri, v_row.source_document_id,
    COALESCE(NULLIF(btrim(p_publication_or_version), ''), v_row.publication_or_version),
    CURRENT_DATE, 'imported', v_row.known_limitations, v_row.version_number + 1,
    NULLIF(btrim(COALESCE(p_review_note, '')), '')
  )
  RETURNING id INTO v_new_id;

  UPDATE public.curriculum_reference_entries
     SET verification_status = 'superseded',
         superseded_by_id = v_new_id,
         superseded_at = now(),
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = COALESCE(NULLIF(btrim(p_review_note), ''), review_note)
   WHERE id = p_entry_id;

  RETURN v_new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.curriculum_catalogue_supersede(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.curriculum_catalogue_supersede(uuid, text, text, text, text) TO figbloom_app;
