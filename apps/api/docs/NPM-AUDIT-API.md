# npm audit for `@figbloom/api`

Policy (Ancel, 2026-11-14): vulnerabilities are **eliminated, not carried**. No audit exception, allowlist, suppression, `overrides` pin, `npm audit fix --force` or non-gating finding is used for this package.

## History

| Date | Scope | Finding | Disposition |
|---|---|---|---|
| 2026-11-12 | `--omit=dev` | `zod` `<4.6.6`, high, GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized constrained collections) | Recorded as open (D-11). A 64 KiB body limit and Zod max lengths were noted as defence in depth, never as the remediation. |
| 2026-11-14 | `--omit=dev` | same | **RESOLVED** (below). |
| 2026-11-14 | full tree (dev included) | 8 findings in the test toolchain (`vitest`, `tinypool`, `vite`, `esbuild`, `@vitest/mocker`, `vite-node`, `source-map-js`) | Remediation is Stage T; recorded separately when done. Not accepted as residual. |

## GHSA-mrhx-c7xc-m3w5 — resolved 2026-11-14

- Cause: `zod@3.25.76` (the only Zod copy; `@figbloom/api` is its only consumer).
- Fix: `zod@4.6.7` (advisory range `<4.6.6`). Importing `zod/v4` from the 3.25 package would not have remediated it, so the package itself was upgraded.
- Commits (branch `ancel-feature`): `b385b5f` code adapted to the Zod 4 API through `zod/v4` while still on 3.25.76; `52b5878` dependency-only upgrade, lockfile diff limited to the `zod` entries; `100794d` imports moved to the root entry; `019ffef` advisory test.
- Contract preserved (DEC-02): ids use `z.guid()` at all eight sites because Zod 4's `.uuid()` is RFC-strict and would reject ids the API accepts today; the pinned corpus (`test/support/validationCorpus.ts`, expected values recorded against 3.25.76 before the change) holds this. Negative control: swapping back to `z.string().uuid()` fails 5 corpus tests.
- Evidence on `52b5878`: `npm ls zod --all` shows one copy, 4.6.7; `npm audit --workspace @figbloom/api --omit=dev` → `found 0 vulnerabilities`; typecheck clean; 246 API tests pass; `openapi:check` 20 paths / 22 operations; `migrate:verify` verified 9; root lint 0 errors.
- Standing guard: `test/dependency.zod.test.ts` fails if any installed, locked or declared Zod is below 4.6.6 (negative controls included).
