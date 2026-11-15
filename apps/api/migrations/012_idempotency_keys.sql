-- FIG-1623 / AD-10 — optional Idempotency-Key for side-effecting POSTs.
-- Forward-only. Migrations 001-011 are not edited.
--
-- One row per (tenant, actor, key). The claim is inserted in the SAME transaction as the
-- business effect and its audit event, and the row is completed in that transaction, so:
--   * a concurrent duplicate blocks on the unique index until the first transaction
--     commits (then it replays) or rolls back (then it proceeds);
--   * there is never a visible "in progress" row and never a committed effect without its row.
-- Only a keyed fingerprint (HMAC, secret from configuration) of the request is stored,
-- never a request or response body: a plain hash of a child's data would be testable
-- against guesses, and a stored body is personal data that would outlive its purpose.
-- Validity is 24 h (configurable), enforced at lookup; deleting expired rows is
-- housekeeping and is never required for correctness.
--
-- Tenant table: ENABLE + FORCE RLS, one explicit policy TO figbloom_app on
-- app_current_tenant_id(), the positive owner policy, minimal grants (no DELETE:
-- cleanup is owner-run housekeeping).

CREATE TABLE public.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL
    CONSTRAINT idempotency_keys_key_format
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 128 AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
  route text NOT NULL,
  fingerprint text NOT NULL CONSTRAINT idempotency_keys_fingerprint_format CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  resource_type text,
  resource_id uuid,
  response_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_unique UNIQUE (tenant_id, actor_user_id, idempotency_key),
  CONSTRAINT idempotency_keys_resource_pair CHECK ((resource_type IS NULL) = (resource_id IS NULL))
);

CREATE INDEX idempotency_keys_expires_idx ON public.idempotency_keys (expires_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_tenant ON public.idempotency_keys
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY idempotency_keys_owner ON public.idempotency_keys
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'idempotency_keys'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'idempotency_keys'
  ));

REVOKE ALL ON TABLE public.idempotency_keys FROM PUBLIC;
REVOKE ALL ON TABLE public.idempotency_keys FROM figbloom_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.idempotency_keys TO figbloom_app;
