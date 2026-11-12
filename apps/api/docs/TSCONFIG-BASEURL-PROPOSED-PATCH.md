# R3-08 — Proposed shared `tsconfig.base.json` change (TEAM APPROVAL)

**Status:** OPEN — TEAM APPROVAL. Not applied.

## Current (team-owned)

```json
"baseUrl": ".",
"ignoreDeprecations": "5.0",
"paths": {
  "@figbloom/shared": ["packages/shared/src/index.ts"],
  "@figbloom/shared/*": ["packages/shared/src/*"]
}
```

## Why it warns

TypeScript deprecates `baseUrl` for TS 7. `paths` currently depends on it. `ignoreDeprecations` is not an acceptable long-term fix.

## Already done in this programme

- Removed redundant `baseUrl` from `apps/api/tsconfig.json` (verified typecheck PASS).

## Proposed team options (pick one)

### Option A — keep paths, migrate off baseUrl when TS supports it
Wait for the team’s chosen TS 7 path-mapping approach; no shared change until then. API-local warning reduced; shared consumers still warn.

### Option B — replace path aliases with relative / package exports
1. Add `"exports"` / `"types"` on `@figbloom/shared` package.json pointing at `src/index.ts`.
2. Remove `baseUrl` + `paths` from `tsconfig.base.json`.
3. Update any imports that relied on `@figbloom/shared/*` deep paths.
4. Run root typecheck for web + mobile + shared.

### Option C — project references
Introduce solution-style project references so apps depend on `packages/shared` without `baseUrl`.

## Recommendation

**Option A short-term** (no shared risk) + schedule **Option B** before TS 7. Do not apply Option B/C in this FIG-1573 closure without team sign-off.
