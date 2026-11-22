-- 087: RFC 6238 section 5.2 — a TOTP code (time step) must be accepted at most once per factor.
-- Records the newest accepted time step; a code for that step or an older one is a replay. Forward-only.
ALTER TABLE mfa_factors ADD COLUMN last_used_step bigint;
GRANT UPDATE (last_used_step) ON mfa_factors TO figbloom_app;
