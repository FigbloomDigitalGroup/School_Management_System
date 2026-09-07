# Repo instructions for AI agents

## Mandatory security check — read `.agents/SECURITY.md` in full before either of:

1. Running any build/dev/lint tooling (`npm run dev`, `npm run build`, `npm run lint`, `vite`, `tsc`, etc.)
2. Creating a git commit

This repo had all four of its git branches (`main`, `dev`, `dev-staging`,
`dev-mike`) force-pushed with a commit that injected an obfuscated payload
into `apps/web/postcss.config.js` (which auto-executes on every build) and
weakened `.gitignore`'s `.env` exclusion. `.agents/SECURITY.md` has the
full incident notes and the exact check to run — do not skip it because
this summary looks sufficient; it isn't.

Quick version of the check, before build/lint/commit:

- Grep every auto-loaded config file (`*.config.js/ts/cjs/mjs` — tailwind,
  postcss, eslint, vite, next, vitest, etc.) for `_0x`, `app-vscode-eval`,
  `verify-human`. Any match is a stop condition.
- Flag any config file that's abnormally large (tens of KB when it should
  be under 5KB) even without a signature match.
- Flag any `.gitignore` change that removes or weakens the `.env`/`.env.*`
  exclusion.
- If anything matches: stop, don't run the command, don't overwrite the
  file yourself, tell the user exactly what you found, and wait.
