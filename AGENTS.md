# Instructions for AI coding agents working in this repo

## Mandatory security check — read `.agents/SECURITY.md` in full before either of:

1. Running any build/dev/lint tooling (`npm run dev`, `npm run build`, `npm run lint`, `vite`, `next dev`, `tsc`, etc.)
2. Creating a git commit

This repo had all four of its git branches force-pushed with a commit that
injected an obfuscated payload into an auto-executed build config file and
weakened `.gitignore`'s `.env` protection. `.agents/SECURITY.md` has the
full incident notes and the exact check to run — don't skip it.

Quick version: grep every auto-loaded config file (tailwind/postcss/eslint/
vite/next/vitest `.config.*`) for `_0x`, `app-vscode-eval`, `verify-human`;
flag any that's abnormally large (tens of KB when it should be under 5KB);
flag any `.gitignore` change weakening the `.env`/`.env.*` exclusion. Any
match: stop, don't run the command, don't overwrite the file yourself,
report exactly what you found, wait for direction.
