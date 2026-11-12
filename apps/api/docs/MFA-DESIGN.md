# MFA design for privileged roles (P1-A — design only)

**Status:** Design artefact. **Not enforced** in P1-A. Enforcement timing = Ancel decision D-6 / later hardening gate.

## Who

Privileged actors: `super_admin`, `org_admin`, `school_admin`, and any holder of `rbac.staff_areas.manage` / `rbac.school_roles.manage`.

## Proposed model

1. Optional TOTP secrets table (`mfa_factors`) keyed by `user_id`, encrypted at rest.
2. Session creation for privileged roles enters `mfa_pending` until a second factor succeeds.
3. Step-up re-auth for security-sensitive mutations (area grants, role assignment, password reset of others).
4. Recovery codes hashed like passwords; single-use.

## Explicit non-goals for P1-A

- No MFA challenge endpoints.
- No SMS OTP MFA (SMS provider absent).
- No claim of MFA compliance in audits until enforcement ships.
