-- Stage 12: register announcement.push on the jobs type allowlist (forward-only).
-- Migration 036 only allowed mpesa.stk_settle. Announcement publish enqueues announcement.push
-- when the push channel is selected; the worker records a delivery ledger row (provider send later).

ALTER TABLE jobs DROP CONSTRAINT jobs_type_chk;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_chk CHECK (job_type IN ('mpesa.stk_settle', 'announcement.push'));
