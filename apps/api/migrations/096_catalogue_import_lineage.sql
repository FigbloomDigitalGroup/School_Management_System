-- 096: curriculum catalogue import detects supersession lineage (forward-only; final closure, R-7).
--
-- Superseding an entry keeps the old row (code X, status 'superseded', superseded_by_id -> new row) and creates a
-- new row coded 'X_v<N>'. The duplicate check in 093/095 ignored superseded rows and compared codes only, so a later
-- import of the base code X found nothing and inserted a second, parallel X. The check now follows
-- superseded_by_id from every row carrying the imported code to the current (non-superseded) head of that lineage
-- and reports that head as the duplicate. No code is renamed or parsed (a legitimate code ending in "_v2" is
-- unaffected) and no existing row changes.

CREATE OR REPLACE FUNCTION public.curriculum_catalogue_import_entry(
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
  PERFORM pg_advisory_xact_lock(hashtextextended('curriculum-import:' || v_tenant::text || ':' || p_entry_kind || ':' || lower(btrim(p_code)), 0));
  WITH RECURSIVE lineage AS (
    SELECT e.id, e.verification_status, e.superseded_by_id, 0 AS depth
      FROM public.curriculum_reference_entries e
     WHERE e.tenant_id = v_tenant
       AND e.entry_kind = p_entry_kind
       AND lower(e.code) = lower(btrim(p_code))
    UNION ALL
    SELECT n.id, n.verification_status, n.superseded_by_id, l.depth + 1
      FROM lineage l
      JOIN public.curriculum_reference_entries n ON n.id = l.superseded_by_id AND n.tenant_id = v_tenant
     WHERE l.verification_status = 'superseded' AND l.depth < 1000
  )
  SELECT l.id INTO v_existing
    FROM lineage l
   WHERE l.verification_status <> 'superseded'
   ORDER BY l.depth DESC, l.id
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
