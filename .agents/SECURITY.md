# Mandatory pre-build / pre-commit security check

On 2026-09-07, `main`, `dev`, `dev-staging`, and `dev-mike` on this repo's
GitHub remote were all force-pushed (from an unconfirmed source — GitHub
account/token compromise or a supply-chain-compromised npm package are both
consistent with what was found) with a commit that:

- Injected an obfuscated JS payload into `apps/web/postcss.config.js`
  (hex-named variables, a self-decoding IIFE — postcss configs are auto
  *executed* by Vite/PostCSS on every `dev`/`build`/`typecheck`, so this ran
  automatically the moment anyone built the project).
- Removed `.env` / `.env.*` from `.gitignore` and added `config.bat` to it
  instead — weakening the one thing keeping real secrets out of git, and
  hiding a dropped batch file from `git status`.

Every other file in that commit was untouched — this was a precise,
automated edit to exactly the two files that matter for this kind of
attack, not manual tampering. Treat any recurrence the same way: precise,
not obviously "broken."

## The check — required before EITHER of:

1. Running any build/dev/lint tooling (`npm run dev`, `npm run build`,
   `npm run lint`, `vite`, `next dev`, `tsc`, etc.)
2. Creating a git commit

**Scan every auto-loaded JS/TS config file in the working tree** —
`tailwind.config.*`, `postcss.config.*`, `eslint.config.*`, `vite.config.*`,
`next.config.*`, `vitest.config.*`, and anything else Node/Vite loads
automatically at build/dev time (not just the ones listed here — check
what the project actually has) — for:

- The obfuscation signature: search for `_0x` in the file. Any match is a
  red flag.
- Known indicator strings: `app-vscode-eval`, `verify-human`.
- Abnormal file size — these files are normally well under 5KB. Tens of KB
  warrants inspection even with no `_0x` match.
- An unexplained change to `.gitignore` that removes or weakens the
  `.env` / `.env.*` exclusion.

**If anything matches:** stop immediately.
- Do not run the build/dev/lint command.
- Do not silently clean or overwrite the file — a naive full-file revert
  can destroy real legitimate config content mixed in with the payload.
- Tell the user exactly what you found (file, match, size) and wait for
  direction.

## If you're setting this up fresh in a session that hasn't seen this file

Run this before your first build/lint/commit of the session:

```
grep -rc '_0x\|app-vscode-eval\|verify-human' -- \
  $(git ls-files '*.config.js' '*.config.ts' '*.config.cjs' '*.config.mjs')
```

Any non-zero count is a stop condition. Also diff `.gitignore` against the
last known-good commit if one exists — a weakened `.env` exclusion with no
other explanation is itself a stop condition, independent of the grep.
