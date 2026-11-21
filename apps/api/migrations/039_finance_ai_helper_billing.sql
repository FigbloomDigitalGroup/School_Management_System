-- Stage 11: AI helper ("Bloom study helper") billing foundations. Forward-only.
--
-- Legacy (supabase/migrations/20261101100000_ai_helper_optin.sql): per-school access mode
-- ('all' | 'opt_in'), a price per learner per term (0..10,000,000 minor units), a cancel window
-- (0..60 days, default 7) and a billing switch HELD OFF by a CHECK; billing is not available in the
-- product. When it is turned on, an opt-in becomes a charge on the learner's current-term invoice.
--
-- Here: the settings (with billing held off by the same kind of CHECK) and the per-learner, per-term
-- opt-in state with an append-only change log. NO charge is created: turning billing on, its pricing,
-- refunds and the charge rule are owner decisions. AI execution and token usage are a separate domain
-- (Stage 13 Bloom AI) and are not stored here.

CREATE TABLE finance_ai_helper_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  access_mode text NOT NULL DEFAULT 'all',
  price_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'KES',
  cancel_days integer NOT NULL DEFAULT 7,
  billing_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_ai_helper_settings_mode_chk CHECK (access_mode IN ('all', 'opt_in')),
  CONSTRAINT finance_ai_helper_settings_price_chk CHECK (price_minor BETWEEN 0 AND 10000000 AND price_minor % 100 = 0),
  CONSTRAINT finance_ai_helper_settings_currency_chk CHECK (currency = 'KES'),
  CONSTRAINT finance_ai_helper_settings_cancel_chk CHECK (cancel_days BETWEEN 0 AND 60),
  -- billing is not available: held off until an owner decision turns it on (legacy tenants_ai_helper_billing_off)
  CONSTRAINT finance_ai_helper_settings_billing_off CHECK (billing_enabled = false)
);

CREATE TABLE finance_ai_helper_optins (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id uuid NOT NULL,
  term_id uuid NOT NULL,
  opted_in boolean NOT NULL,
  changed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, learner_id, term_id),
  CONSTRAINT finance_ai_helper_optins_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_ai_helper_optins_term_fk FOREIGN KEY (term_id, tenant_id) REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE finance_ai_helper_optin_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id uuid NOT NULL,
  term_id uuid NOT NULL,
  opted_in boolean NOT NULL,
  changed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_ai_helper_optin_log_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_ai_helper_optin_log_term_fk FOREIGN KEY (term_id, tenant_id) REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_ai_helper_settings', 'finance_ai_helper_optins', 'finance_ai_helper_optin_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO figbloom_app', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM figbloom_app', t);
  END LOOP;
END $$;

GRANT UPDATE (access_mode, price_minor, cancel_days, updated_by, updated_at) ON finance_ai_helper_settings TO figbloom_app;
GRANT UPDATE (opted_in, changed_by, changed_at) ON finance_ai_helper_optins TO figbloom_app;
