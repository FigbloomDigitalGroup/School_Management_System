# D-11 — npm audit for `@figbloom/api` dependencies

**Recorded:** 2026-11-12  
**Command:** `npm audit --workspace @figbloom/api --omit=dev`

| Package | Severity | Advisory | Disposition |
|---|---|---|---|
| `zod` `<4.6.6` | high | GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized constrained collections) | **OPEN — follow-up**: fix requires `zod@4.x` (breaking). API already bounds body size (64 KiB) and Zod max lengths (AUD-13). Do not `audit fix --force` in this programme. Track as dependency upgrade with Ancel/team. |

No other production-dep advisories reported for the API workspace in this run.
