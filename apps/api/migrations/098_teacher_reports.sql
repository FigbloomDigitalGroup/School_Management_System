-- Teacher Reports (typed or handwritten OCR capture with full editability and review). Forward-only.

CREATE TABLE teacher_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  author_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  class_id          uuid,
  learner_id        uuid,
  report_type       text NOT NULL DEFAULT 'daily',
  report_date       date NOT NULL DEFAULT CURRENT_DATE,
  title             text NOT NULL,
  input_mode        text NOT NULL DEFAULT 'typed',
  raw_ocr_text      text,
  body              text NOT NULL,
  ocr_confidence    numeric(4,3),
  ocr_provider      text,
  source_image_mime text,
  status            text NOT NULL DEFAULT 'draft',
  submitted_at      timestamptz,
  reviewed_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  review_note       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teacher_reports_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT teacher_reports_class_fk FOREIGN KEY (class_id, tenant_id) REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT teacher_reports_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT teacher_reports_type_chk CHECK (report_type IN ('daily', 'weekly', 'incident', 'progress', 'observation')),
  CONSTRAINT teacher_reports_mode_chk CHECK (input_mode IN ('typed', 'handwritten_ocr', 'hybrid')),
  CONSTRAINT teacher_reports_status_chk CHECK (status IN ('draft', 'submitted', 'reviewed')),
  CONSTRAINT teacher_reports_title_len CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT teacher_reports_body_len CHECK (char_length(btrim(body)) BETWEEN 1 AND 10000)
);

CREATE INDEX teacher_reports_tenant_date_idx
  ON teacher_reports (tenant_id, report_date DESC, created_at DESC, id);
CREATE INDEX teacher_reports_author_idx
  ON teacher_reports (tenant_id, author_user_id, created_at DESC);

ALTER TABLE teacher_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY teacher_reports_tenant ON teacher_reports FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY teacher_reports_owner ON teacher_reports FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'teacher_reports'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'teacher_reports'));

GRANT SELECT, INSERT ON teacher_reports TO figbloom_app;
GRANT UPDATE (class_id, learner_id, report_type, report_date, title, input_mode, body, status, submitted_at, reviewed_by, reviewed_at, review_note, updated_at)
  ON teacher_reports TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON teacher_reports FROM figbloom_app;
