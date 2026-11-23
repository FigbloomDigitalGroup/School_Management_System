# Identity / tenancy column–index dictionary (P1-A start)

Isolated replacement schema in database `figbloom_api`. Legacy Supabase tables are unchanged.

| Table | Column | Type | Constraints / indexes | Notes |
|---|---|---|---|---|
| organizations | id | uuid PK | | Org container for schools |
| organizations | slug | text | UNIQUE, format check | |
| organizations | status | text | pending/active/suspended/rejected | Only `active` grants org admin reach |
| tenants | id | uuid PK | | School / tenant |
| tenants | organization_id | uuid FK | INDEX | NOT NULL |
| tenants | slug | text | UNIQUE | Path segment |
| tenants | status | text | INDEX | `suspended` blocks membership use |
| users | id | uuid PK | | Canonical identity |
| users | email | text | UNIQUE, lower-case check | Null for login_id accounts |
| users | password_hash | text | NOT NULL | scrypt encoding; never plaintext |
| school_memberships | (user_id, tenant_id) | | UNIQUE | Explicit membership |
| school_memberships | (tenant_id, login_id) | | UNIQUE partial (active) | Case-insensitive |
| school_memberships | role | text | school roles only | No retired guard/receptionist |
| platform_roles | user_id | uuid PK | | `super_admin` only |
| organization_memberships | (user_id, organization_id) | | UNIQUE | Multi-org allowed |
| sessions | token_hash | text | UNIQUE | SHA-256 of opaque token |
| sessions | expires_at / revoked_at | timestamptz | partial indexes | Lifecycle |
| permissions | code | text PK | | Extensible catalog |
| role_permissions | (role, permission_code) | | PK | Base grants |
| staff_area_grants | (user_id, tenant_id, area) | | PK; tenant INDEX; FK (user_id, tenant_id) → school_memberships | Direct admin areas; cannot exist without a membership in that school (002) |
| school_roles | (tenant_id, lower(trim(name))) | | UNIQUE; UNIQUE (id, tenant_id) | Custom school roles |
| school_role_assignments | (user_id, role_id) | | PK; FK (role_id, tenant_id) → school_roles; FK (user_id, tenant_id) → school_memberships | Role and member must belong to the assignment's tenant (002) |
| auth_rate_buckets | bucket_key | text PK | INDEX last_refill | Token bucket state; mutated only by `consume_rate_token()`; `prune_rate_buckets()` removes idle rows (scheduler is Phase 2) |
| security_audit_events | tenant_id, actor, type | | time indexes; trigger `security_audit_events_append_only` | Append-only: UPDATE/DELETE refused except FK SET NULL of actor/tenant (002) |

Migration note: `002` adds composite foreign keys and will refuse to apply if existing rows violate them (e.g. a role assigned across tenants). Find offenders first: `school_role_assignments` whose `role_id`'s tenant differs, and grants/assignments with no matching `school_memberships` row. P1-A has no production data (F-008).

Migration `003` (Session-2 remediation): `consume_rate_token` returns NULL `out_retry_after_ms` when cost > capacity; `GRANT EXECUTE` to `CURRENT_USER`; trigger `school_memberships_archive_clears_authz` deletes `staff_area_grants` / `school_role_assignments` when a membership is archived.
