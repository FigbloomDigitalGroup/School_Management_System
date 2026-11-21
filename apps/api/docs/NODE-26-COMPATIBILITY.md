# Node 26 compatibility (FIG-1616)

> OD-5: do not change `engines` or CI Node version without team confirmation.

## Runtime availability (2026-11-16)

| Source | Result |
|---|---|
| Active shell | Node **v24.16.0** (`C:\Program Files\nodejs\node.exe`) |
| nvm / fnm | Not present in the default profile |
| winget catalogue | `OpenJS.NodeJS` **26.12.1**, `OpenJS.NodeJS.LTS` **26.13.1** listed |
| Installed Node 26 binary | Portable zip under `.tools/node-v26.12.1-win-x64` (session-local; **not** on PATH; system default remains v24.16.0) |

## Disposition

Node 26 remains the approved **target direction**, subject to compatibility evidence and team confirmation (OD-5). A portable binary was obtained for verification only:

- Do **not** change root/`apps/api` `engines` or CI Node pins without OD-5.
- Do **not** claim production readiness from package metadata alone.
- Record verification results below when the suite is run under the portable binary.

## Verification performed (portable Node v26.12.1, 2026-11-16)

| Item | Result |
|---|---|
| Binary source | Official `node-v26.12.1-win-x64.zip` under `.tools/` (gitignored) |
| SHA-256 | Matches official `SHASUMS256.txt` (`b3efd5c7…25e2b4` per independent review) |
| Installation completed? | Portable extract only (not a system-wide install; default PATH remains Node 24.16.0) |
| Clean install under Node 26? | **Not tested** — do not claim clean-install compatibility |
| Tests/builds executed? | Yes, with existing `node_modules` (installed under Node 24), PATH prepended with portable binary |
| `node -v` | v26.12.1 |
| typecheck / openapi:check / build | exit 0 |
| compiled `migrate --verify` | verified 13 at review time; now 14 after migration 014 |
| Full API suite | **38 files / 392 passed** (independent review); re-verify after this remediation |
| `engines` / CI Node pin | **unchanged** (await OD-5) |

Remaining limitations: no clean install under Node 26, Windows OS signal handling not separately exercised, out-of-harness start/stop smoke not claimed, OD-5 team confirmation pending.
