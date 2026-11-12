# TypeScript `baseUrl` resolution (R3-08)

**Status:** DOCUMENTED · OPEN — TEAM APPROVAL for shared config change

## Inheritance

| File | `baseUrl` | Notes |
|---|---|---|
| `tsconfig.base.json` (team-owned) | `"."` | Also sets `paths` for `@figbloom/shared` and `ignoreDeprecations: "5.0"` |
| `apps/api/tsconfig.json` | `"."` (local override) | API does **not** use path aliases |

## Findings

- The editor deprecation warning for TypeScript 7.0 is inherited primarily from **shared** `tsconfig.base.json`.
- `paths` in the shared base **depend on** `baseUrl`.
- Removing `baseUrl` from shared without replacing `paths` (e.g. with relative imports or a bundler alias) would break web/mobile consumers.
- `ignoreDeprecations` is **already** present in shared config — the programme must **not** treat that as the fix.

## Proposed team change (not applied)

1. Keep `paths` working via a supported TS 7 approach once the team selects one (e.g. project references / explicit relative imports / updated path mapping).
2. Remove redundant `baseUrl` from `apps/api/tsconfig.json` only after confirming API compiles without it:

```json
"compilerOptions": {
  // remove "baseUrl": "."
}
```

3. Do **not** modify `tsconfig.base.json` in this programme without Ancel/team approval.

## Local mitigation applied in this programme

- Removed redundant `baseUrl` from `apps/api/tsconfig.json`.
- Verified: `npm run typecheck --workspace @figbloom/api` PASS after removal.
- Shared `tsconfig.base.json` **unchanged** (still needs team approval for TS 7 path strategy).
- Residual editor warning from shared base may remain until team change lands.
