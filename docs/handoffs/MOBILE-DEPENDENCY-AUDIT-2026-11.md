# Mobile-team dependency vulnerability handoff (WP-A1)

> **Responsible mobile owner:** ownership **pending** (not confirmed; do not invent an assignee).  
> **Backend remediator:** must not modify `apps/mobile` source, manifests, or lockfile paths owned by mobile product work.  
> **Evidence date:** 2026-11-16. Source: root `npm audit` (35 total; **28 mobile-tree** + **7 root**).  
> **Backend security status is separate from whole-repository security status.** `@figbloom/api` audits at 0; mobile findings remain outstanding.  
> Team-accessible path outside `apps/mobile` and outside `.personal-ai/`: `docs/handoffs/MOBILE-DEPENDENCY-AUDIT-2026-11.md`.

## Summary

| Bucket | Count | Action for mobile team |
|---|---|---|
| Non-breaking lockfile refresh (within existing semver) | several high/critical clearable | Authorise and apply; run mobile Jest + device/emulator smoke |
| Firebase / `@grpc/grpc-js` chain | several high | Upstream pin; app source does not call Firestore (static); needs decision |
| React Native CLI / Metro tooling | moderate/high | Follows RN upgrade |
| Jest / deepmerge | low | Follows RN / Jest major |

## Per-finding register (28 mobile — listed individually)

| # | Package (advisory path) | Sev | Advisory / via | Dependency path (abbrev) | Fixed stable (if known) | Recommended remediation |
|---|---|---|---|---|---|---|
| 1 | shell-quote@1.10.0 | critical | GHSA-pqg4-j6r4-53mv | RN → react-devtools-core | 1.11.0+ | Lockfile refresh |
| 2 | node-forge@1.4.0 | high | GHSA-9gx9-hrmj-r63f (and related forge advisories on this version) | Metro selfsigned | 1.4.3 | Lockfile refresh |
| 3 | joi@17.13.7 | high | GHSA-wr44-6hxh-3jwq, GHSA-4528-x5fx-h6hg | RN CLI config | 17.13.9 | Lockfile refresh |
| 4 | compression@1.8.1 | high | GHSA-vc2v-76pw-4v95 | CLI server-api | 1.8.2 | Lockfile refresh |
| 5 | decode-uri-component@0.2.2 | high | GHSA-vcc3-ghjq-m6fr, GHSA-qr28-fpjm-wq7f | @react-navigation/core → query-string | 0.5.1 | Lockfile refresh of navigation |
| 6 | query-string@7.1.3 | high | via decode-uri-component | @react-navigation/core | removed by core≥7.25 | Lockfile refresh |
| 7 | @react-navigation/core@7.21.13 | high | via query-string | bottom-tabs → native | 7.25.0 | Lockfile refresh |
| 8 | @grpc/grpc-js@1.9.16 | high | GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4 | firebase → firestore | 1.13.6 (outside pin) | Upstream / RN Firebase decision |
| 9 | @firebase/firestore@4.7.8 | high | via grpc | firebase | n/a chain | Same as grpc |
| 10 | @firebase/firestore-compat@0.3.43 | high | via firestore | firebase | n/a chain | Same |
| 11 | firebase@11.3.1 | high | via firestore | @react-native-firebase/app | n/a chain | Same |
| 12 | @react-native-firebase/app@21.14.0 | high | via firebase | messaging | n/a | Decision |
| 13 | @react-native-firebase/messaging@21.14.0 | high | via app | direct | n/a | Decision |
| 14 | image-size@1.2.1 | high | GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr | metro | 2.0.3 | RN/Metro upgrade |
| 15 | fast-xml-parser@4.5.7 | moderate | GHSA-gh4j-gqv2-49f6, GHSA-474x-hrwr-fgx4 | RN CLI android | 5.12.0 | RN CLI upgrade |
| 16 | @react-native-community/cli@15.0.1 | low–moderate | via deepmerge / platform packages | RN 0.76.9 plugin | newer majors | RN upgrade |
| 17 | @react-native-community/cli-config | low | via deepmerge | cli | newer majors | RN upgrade |
| 18 | @react-native-community/cli-doctor | moderate | via config / platform-* | cli | newer majors | RN upgrade |
| 19 | @react-native-community/cli-platform-android | moderate | via fast-xml-parser | cli-doctor | newer majors | RN upgrade |
| 20 | @react-native-community/cli-platform-apple | moderate | via fast-xml-parser | cli-doctor / ios | newer majors | RN upgrade |
| 21 | @react-native-community/cli-platform-ios | moderate | via platform-apple | cli | newer majors | RN upgrade |
| 22 | jest@29.7.0 | low | via @jest/core, jest-cli | @testing-library/react-native | Jest 30 needs RN≥0.78 | RN upgrade |
| 23 | @jest/core | low | via jest-config | jest | Jest 30 | RN upgrade |
| 24 | jest-cli | low | via @jest/core, create-jest, jest-config | jest | Jest 30 | RN upgrade |
| 25 | jest-config | low | via deepmerge | @jest/core | Jest 30 | RN upgrade |
| 26 | create-jest | low | via jest-config | jest-cli | Jest 30 | RN upgrade |
| 27 | deepmerge@4.3.1 | low | GHSA-gcqx-w48m-w2h4 | jest-config | none unaffected | Wait / Jest upgrade |
| 28 | @testing-library/react-native@13.3.3 | low | via jest | direct | 14.x needs RN≥0.78 | RN upgrade |

## Root tooling residual (not mobile; tracked for completeness)

Seven root rows are the single `minimatch@10.2.6` path through `typescript-eslint@8.69.0` (OD-2 / R-03). See `apps/api/docs/R-03-MINIMATCH-DISPOSITION.md`. **No dependency override or suppression authorised.**

## Proposed mobile sequence

1. Authorise non-breaking lockfile refresh for clearable critical/high rows; verify with mobile Jest and a device/emulator smoke (navigation ships).
2. Decide Firebase/`@grpc/grpc-js` residual (wait upstream vs replace vs documented accepted residual with owner sign-off).
3. Plan React Native upgrade as its own package for CLI/Metro/Jest remainder.

## fe40f9b authorisation (OD-4) — authorization issue

Commit `fe40f9b` (`build(mobile): scope Node types to the four tests that need them (Part of FIG-1615)`, author Ancel Ajanga) touched:

- `apps/mobile/package.json`
- `apps/mobile/tsconfig.json`
- `apps/mobile/tsconfig.node-tests.json`
- `apps/mobile/tests/integrity/mobileTypes.test.ts`

DEC-05 authorises root tooling and `apps/web` manifests only and says `apps/mobile` is outside it unless D-T2 is approved. **No written authorisation for this mobile edit was found.** Independent verification recorded this as an **authorization issue requiring owner/team clarification (OD-4)**.

**Do not revert or overwrite that work** without explicit instruction. Backend remediator must not modify or revert `fe40f9b`.

## Explicit non-claims

- These findings are **not** fixed by WP-A1 backend closure.
- They must **not** be counted toward backend security clearance.
- Whole-repository `npm audit` remains non-zero until mobile (and root minimatch — OD-2) are cleared.
- Backend remediator must not change mobile implementation or dependencies.
- Mobile owner remains **pending** until Ancel/team names one.
