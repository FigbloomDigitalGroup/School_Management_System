-- Bank Statement Reconciliation (imports, line items, auto-matching, manual matching, ignore). Forward-only.

CREATE TABLE finance_bank_statements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  bank_name             text NOT NULL,
  account_number        text NOT NULL,
  statement_from        date,
  statement_to          date,
  currency              text NOT NULL DEFAULT 'KES',
  opening_balance_minor bigint,
  closing_balance_minor bigint,
  row_count             integer NOT NULL DEFAULT 0,
  matched_count         integer NOT NULL DEFAULT 0,
  unmatched_count       integer NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'open',
  uploaded_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_bank_statements_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_bank_statements_bank_len CHECK (char_length(btrim(bank_name)) BETWEEN 1 AND 120),
  CONSTRAINT finance_bank_statements_acct_len CHECK (char_length(btrim(account_number)) BETWEEN 1 AND 60),
  CONSTRAINT finance_bank_statements_status_chk CHECK (status IN ('open', 'reconciled'))
);

CREATE INDEX finance_bank_statements_tenant_idx
  ON finance_bank_statements (tenant_id, created_at DESC, id);

ALTER TABLE finance_bank_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_bank_statements FORCE ROW LEVEL SECURITY;

CREATE POLICY finance_bank_statements_tenant ON finance_bank_statements FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY finance_bank_statements_owner ON finance_bank_statements FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'finance_bank_statements'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'finance_bank_statements'));

GRANT SELECT, INSERT ON finance_bank_statements TO figbloom_app;
GRANT UPDATE (matched_count, unmatched_count, status) ON finance_bank_statements TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON finance_bank_statements FROM figbloom_app;

CREATE TABLE finance_bank_statement_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  statement_id       uuid NOT NULL,
  line_no            integer NOT NULL,
  txn_date           date NOT NULL,
  reference          text,
  reference_norm     text,
  description        text NOT NULL DEFAULT '',
  amount_minor       bigint NOT NULL,
  direction          text NOT NULL,
  balance_minor      bigint,
  match_status       text NOT NULL DEFAULT 'unmatched',
  matched_payment_id uuid,
  matched_invoice_id uuid,
  matched_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  matched_at         timestamptz,
  match_note         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_bank_statement_lines_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_bank_statement_lines_stmt_fk
    FOREIGN KEY (statement_id, tenant_id) REFERENCES finance_bank_statements (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_bank_statement_lines_payment_fk
    FOREIGN KEY (matched_payment_id, tenant_id) REFERENCES finance_payments (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_bank_statement_lines_invoice_fk
    FOREIGN KEY (matched_invoice_id, tenant_id) REFERENCES finance_invoices (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_bank_statement_lines_amount_pos CHECK (amount_minor > 0),
  CONSTRAINT finance_bank_statement_lines_dir_chk CHECK (direction IN ('credit', 'debit')),
  CONSTRAINT finance_bank_statement_lines_status_chk
    CHECK (match_status IN ('unmatched', 'auto_matched', 'manual_matched', 'ignored'))
);

CREATE INDEX finance_bank_statement_lines_stmt_idx
  ON finance_bank_statement_lines (tenant_id, statement_id, line_no);
CREATE INDEX finance_bank_statement_lines_ref_idx
  ON finance_bank_statement_lines (tenant_id, reference_norm) WHERE reference_norm IS NOT NULL;

ALTER TABLE finance_bank_statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_bank_statement_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY finance_bank_statement_lines_tenant ON finance_bank_statement_lines FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY finance_bank_statement_lines_owner ON finance_bank_statement_lines FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'finance_bank_statement_lines'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'finance_bank_statement_lines'));

GRANT SELECT, INSERT ON finance_bank_statement_lines TO figbloom_app;
GRANT UPDATE (match_status, matched_payment_id, matched_invoice_id, matched_by, matched_at, match_note)
  ON finance_bank_statement_lines TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON finance_bank_statement_lines FROM figbloom_app;
