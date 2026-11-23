-- Stage 16 audit remediation (S16-8, S16-9): allow figbloom_app to redact preview_json PII upon batch application.
-- Forward-only. No earlier migration is edited.

GRANT UPDATE (preview_json) ON TABLE public.import_batches TO figbloom_app;
