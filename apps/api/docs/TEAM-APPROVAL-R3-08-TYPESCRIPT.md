# TEAM APPROVAL — R3-08: Shared TypeScript `baseUrl` deprecation

**Status:** APPLY-READY PROPOSAL · **OPEN — TEAM APPROVAL** · Shared `tsconfig.base.json` **not** modified  
**Issue:** FIG-1573 / finding R3-08  
**Owner for merge:** team (shared TypeScript config)  
**Do not silence the warning with `ignoreDeprecations: "6.0"`.**

---

## 1. Root cause

TypeScript **5.x** deprecates `compilerOptions.baseUrl` (removal targeted for TypeScript **7.0**).  
This repository’s shared base config declares it:

```json
// tsconfig.base.json (team-owned)
"baseUrl": ".",
"ignoreDeprecations": "5.0",
"paths": {
  "@figbloom/shared": ["packages/shared/src/index.ts"],
  "@figbloom/shared/*": ["packages/shared/src/*"]
}
```

Editors surface the deprecation for every package that `extends` this file.  
`ignoreDeprecations: "5.0"` is already present and is **not** an acceptable long-term fix for TS 7.

## 2. Configuration inheritance

| Config | Extends base? | Own `baseUrl`? | Own `paths`? |
|---|---|---|---|
| `tsconfig.base.json` | — | **Yes** `"."` | `@figbloom/shared`, `@figbloom/shared/*` |
| `packages/shared/tsconfig.json` | Yes | No | No |
| `apps/web/tsconfig.json` | Yes | No | Overrides `@/*` + `@figbloom/shared` → relative `../../packages/shared/...` |
| `apps/mobile/tsconfig.json` | Yes | No | Overrides `@figbloom/shared` → relative path |
| `apps/api/tsconfig.json` | Yes | **Removed** in this programme | None (API does not use path aliases) |

Installed TypeScript (local + CI node 22 / package range `^5.6.0`): **5.9.3**.

`npx tsc -p apps/api/tsconfig.json --showConfig` still shows inherited `baseUrl` (rewritten relative to the API package) and `paths` from the shared base.

## 3. Affected packages

Removing `baseUrl` **without** a replacement for `paths` affects any consumer that relies on base `paths` (shared typecheck, and any import that does not already override paths).  
Web and mobile already override `@figbloom/shared` with **relative** paths.  
No `from "@figbloom/shared/..."` deep imports were found under `apps/` (package root imports only).  
`@figbloom/shared` `package.json` currently exposes `"main": "src/index.ts"` (no formal `exports` map yet).

## 4. Proposed change (minimal safe shared plan)

### Already done (API-local — no team approval needed)

- Removed redundant `"baseUrl": "."` from `apps/api/tsconfig.json`.
- API typecheck PASS (`npm run typecheck --workspace @figbloom/api`).

### Proposed shared change (requires approval) — **Option B (recommended)**

1. Add package exports on `packages/shared/package.json`, e.g.:

```json
"exports": {
  ".": "./src/index.ts"
},
"types": "./src/index.ts"
```

2. In `tsconfig.base.json`, **remove** `baseUrl` and `paths` (and leave `ignoreDeprecations` alone or delete it once unused).
3. Keep web/mobile relative `paths` overrides as a belt-and-braces during transition, or delete them once Node/TS resolution via the workspace package name is verified.
4. Run: root `npm run typecheck`, `npm run lint`, web/mobile builds as the team requires.

### Rejected as the fix

- Raising `ignoreDeprecations` to `"6.0"` / `"7.0"` to hide the warning.
- Editing shared config in this closure programme without sign-off.

### Short-term Option A (if team wants zero shared risk now)

Defer shared edit until a dedicated TS-7 cleanup issue; accept editor warnings on packages that still inherit `baseUrl`. API-local mitigation already reduces API-specific noise. **Does not close R3-08.**

## 5. Compatibility analysis

| Consumer | Impact of Option B |
|---|---|
| `@figbloom/api` | None — no path aliases; already typechecks without local `baseUrl` |
| `@figbloom/web` | Low — already maps `@figbloom/shared` relatively; verify after removing base paths |
| `@figbloom/mobile` | Low — same as web |
| `packages/shared` | Low — self-contained; confirm `tsc -p packages/shared` |
| CI `checks` job | Must stay green after the shared edit |

## 6. Typecheck evidence (this machine)

| Check | Result |
|---|---|
| TypeScript version | **5.9.3** |
| `npm run typecheck --workspace @figbloom/api` | PASS |
| Root `npm run typecheck` (shared + web + mobile) | PASS (`ROOT_TC:0`) |
| API still inherits `baseUrl` from shared (`--showConfig`) | Yes — warning source remains until shared change |

Isolated “API without shared base” probe: standalone tsconfig without `baseUrl`/`paths` is the intended end state for API; full shared Option B must be validated by the team on web/mobile after the approved edit.

## 7. Potential impact on other packages

- Any undocumented tooling that depended on base `paths` for `@figbloom/shared/*` deep imports would break (none found in `apps/`).
- Expo/metro already use the workspace package name; confirm bundler resolution after exports are added.

## 8. Required team approval

1. Approve **Option B** (or explicitly choose Option A deferral / Option C project references).
2. Authorized engineer applies the shared `tsconfig.base.json` (+ optional `packages/shared` exports) change.
3. Green root typecheck (and CI `checks` job) on the resulting PR.
4. Only then mark R3-08 **CLOSED AND VERIFIED**.

**Until step 3–4, R3-08 remains OPEN — TEAM APPROVAL (shared).** API-local work alone does not close it.
