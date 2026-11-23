# npm audit for `@figbloom/api`

Policy (Ancel, 2026-11-14): vulnerabilities are **eliminated, not carried**. No audit exception, allowlist, suppression, `overrides` pin, `npm audit fix --force` or non-gating finding is used for this package.

## History

| Date | Scope | Finding | Disposition |
|---|---|---|---|
| 2026-11-12 | `--omit=dev` | `zod` `<4.6.6`, high, GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized constrained collections) | Recorded as open (D-11). A 64 KiB body limit and Zod max lengths were noted as defence in depth, never as the remediation. |
| 2026-11-14 | `--omit=dev` | same | **RESOLVED** (below). |
| 2026-11-14 | full tree (dev included) | 8 findings in the test toolchain (`vitest`, `tinypool`, `vite`, `esbuild`, `@vitest/mocker`, `vite-node`, `source-map-js`) | **RESOLVED** by Stage T (below). Not accepted as residual. |
| 2026-11-15 | whole repository | 35 findings remain, none in `@figbloom/api`, `@figbloom/web` or `packages/shared` | 29 in the `apps/mobile` tree and 6 in the root `typescript-eslint` chain; **open decisions**, see "Not remediated" below. |

## GHSA-mrhx-c7xc-m3w5 — resolved 2026-11-14

- Cause: `zod@3.25.76` (the only Zod copy; `@figbloom/api` is its only consumer).
- Fix: `zod@4.6.7` (advisory range `<4.6.6`). Importing `zod/v4` from the 3.25 package would not have remediated it, so the package itself was upgraded.
- Commits (branch `ancel-feature`): `b385b5f` code adapted to the Zod 4 API through `zod/v4` while still on 3.25.76; `52b5878` dependency-only upgrade, lockfile diff limited to the `zod` entries; `100794d` imports moved to the root entry; `019ffef` advisory test.
- Contract preserved (DEC-02): ids use `z.guid()` at all eight sites because Zod 4's `.uuid()` is RFC-strict and would reject ids the API accepts today; the pinned corpus (`test/support/validationCorpus.ts`, expected values recorded against 3.25.76 before the change) holds this. Negative control: swapping back to `z.string().uuid()` fails 5 corpus tests.
- Evidence on `52b5878`: `npm ls zod --all` shows one copy, 4.6.7; `npm audit --workspace @figbloom/api --omit=dev` → `found 0 vulnerabilities`; typecheck clean; 246 API tests pass; `openapi:check` 20 paths / 22 operations; `migrate:verify` verified 9; root lint 0 errors.
- Standing guard: `test/dependency.zod.test.ts` fails if any installed, locked or declared Zod is below 4.6.6 (negative controls included).

## Test toolchain (Stage T, decision M1) — resolved 2026-11-15

- Before: `vitest 2.1.9`, `vite 5.4.21`, `tinypool 1.1.1`, `vite-node 2.1.9`, `@vitest/mocker 2.1.9`, `esbuild 0.21.5`, `source-map-js 1.2.1`. `npm audit --workspace @figbloom/api`: 8 findings (2 critical, 3 high, 3 moderate); 7 after the Zod fix.
- After: `vitest 4.1.12`, `vite 6.4.6` (one copy in the tree), `@vitest/mocker 4.1.12`, `esbuild 0.25.12`, `source-map-js 1.2.2`; **no** `tinypool` or `vite-node`. `@vitejs/plugin-react` stays at 4.7.0. `npm audit --workspace @figbloom/api` and `--workspace @figbloom/web`: **0 vulnerabilities**.
- Commits: `271c05a` dependency upgrade (root `vitest`/`vite`, `apps/api` `vitest`, `apps/web` `vite`; `vitest.config.ts` `maxWorkers: 4`); `403e016` lockfile patch update (`brace-expansion`, `postcss-selector-parser`). Preceding adaptations: `af9b0aa` (secrets scan reads each file once), `4d75be2` (mobile typecheck declares `node` types).
- Root declaration of `vite`: without `"vite": "^6.4.6"` in the root manifest npm nests `vite 8.3.8` under vitest; the root declaration makes the whole tree use 6.4.6.
- No `overrides`, allowlist, suppression, `--force` or non-gating finding was used. No `engines` field changed (vite 6 and vitest 4 both run on the declared `>=20` range per their own `engines`; verified on Node 24.16.0 only).
- Evidence: typecheck (all workspaces), root unit 103 files / 1765 (1746 pass + 19 expected-fail, identical to the pre-upgrade baseline), `apps/api` 23 files / 252 tests, `openapi:check`, `migrate:verify`, root lint (0 errors), mobile Jest 395, web production build. Web bundle: entry chunk 145.89 -> 147.21 kB, CSS unchanged, shared chunk re-partitioned; browser target unchanged (Vite 6 keeps the `modules` default). Playwright end-to-end flows were **not** run for this stage (no product code changed; see the evidence file).
- Vitest 3/4 semantics reviewed: `mockReset` is used only on mocks created without an implementation (identical behaviour); no snapshots, `poolOptions`, coverage or `environment` overrides exist.

## Not remediated (open decisions, nothing accepted)

- **`typescript-eslint` chain (root lint tooling, 6 moderate)**: `typescript-eslint 8.72.2` is the latest stable release and its `typescript-estree` depends on `minimatch ^10`, whose fix is 11.x (GHSA-g3hv-75wg-m249). Only an `8.72.3` alpha canary depends on minimatch 11. No supported fix exists today.
- **`apps/mobile` dependency tree (29)**: outside the Stage T authorisation; classified in the local disposition report (16 with an npm non-major fix, 13 needing a major upgrade or with no real fix).
