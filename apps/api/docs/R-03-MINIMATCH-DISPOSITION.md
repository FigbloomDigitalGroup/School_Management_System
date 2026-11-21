# R-03 minimatch / typescript-eslint disposition (WP-A1)

> Owner decision **OD-2**. Default disposition from the Stage 0 handoff: **wait for a stable `typescript-eslint` release**; do not override; do not suppress; do not force an unstable release.

## Advisory

- **GHSA-g3hv-75wg-m249** — minimatch potential DoS via globparts amplification.
- Range: `>=7.0.0 <11.0.1` (first patched `11.0.1`).
- Installed vulnerable instance (as of remediation baseline): `minimatch@10.2.6` at  
  `node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch`.
- Path: `typescript-eslint@8.69.0 → @typescript-eslint/typescript-estree@8.69.0 → minimatch@10.2.6`.
- The seven root `npm audit` rows are the **same single path** counted at each dependent package, not seven distinct vulnerabilities.
- Dev-only (lint toolchain). Not a runtime dependency of `apps/api`.

## Reachability (independently verified)

- Vulnerable code path requires `optimizationLevel >= 2`.
- Default `optimizationLevel` is `1` (confirmed in minimatch’s published `dist/commonjs/index.js` behaviour described by independent review).
- Sole call site in `typescript-estree`: `minimatch(filePath, pattern, { dot: true })` with developer-controlled `allowDefaultProject` patterns — not attacker input at runtime.
- **Conclusion:** not reachable in the current configuration.

## Upstream status (re-check procedure)

On or after 17 Nov 2026, re-check:

```bash
npm view typescript-eslint dist-tags
npm view typescript-eslint@latest dependencies
npm view typescript-eslint@canary dependencies
```

Baseline re-check (2026-11-16, `npm view`):

| Tag / package | Version | minimatch declared |
|---|---|---|
| `typescript-eslint@latest` | 8.72.2 | (via estree) |
| `@typescript-eslint/typescript-estree@8.72.2` | — | `^10.2.2` — **no stable fix** |
| `typescript-eslint@canary` | 8.72.3-alpha.8 | |
| `@typescript-eslint/typescript-estree@8.72.3-alpha.8` | — | `^11.0.1` — clears advisory but is prerelease |

## Disposition

| Option | Allowed now? | Notes |
|---|---|---|
| Wait for stable upstream | **Yes (default, OD-2)** | Recorded residual; unreachable; dev-only |
| Adopt canary | Only with explicit owner approval | Dev-only; may churn rules/parser |
| `overrides` to minimatch `^11.0.1` | No without owner approval | Forces major on untested upstream combination |
| Suppress advisory / fake green audit | **Never** | Forbidden |

If a **stable** `typescript-eslint` release appears that clears the advisory, apply it and re-run root lint + API typecheck. Until then leave open under OD-2 / FIG-1615 comments. Do not amend DEC-06 via silent exception without Ancel.

## Separation from mobile

The 28 mobile audit findings are a different tree and owner. See `docs/handoffs/MOBILE-DEPENDENCY-AUDIT-2026-11.md`.
