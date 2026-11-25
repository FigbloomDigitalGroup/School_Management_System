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

## Before opening a PR into `dev-staging` or `main` — mandatory

`main` is production. `CHANGELOG.md` lists what is live, the tables, functions, policies and edge function actions
every branch must keep, and what the new API (`apps/api`) doesn't cover yet. Read it in full before you change
anything under `supabase/` or `apps/api/`, and before you open a PR into `dev-staging` or `main`.

Then, before you open the PR (or tell the developer it's ready):

1. Run `sh scripts/pre-pr-check.sh`. If it fails, **don't open the PR**. Fix what it names, or tell the developer
   exactly what it said and stop. Never work around it: don't edit the script, skip a step, or edit migrations that are
   already on `main` to make it pass.
2. If it warns, fix the warning or explain in the PR description why it's fine.
3. Don't remove, rename or change the arguments or returned columns of anything `CHANGELOG.md` lists as live.
   Add new objects next to the old ones instead.
4. Don't build a second version of a feature `CHANGELOG.md` lists. Extend the one that's there.
5. Code that touches attendance must work with and without the four pending attendance migrations named under
   "Unreleased".
6. If the PR moves a screen onto `apps/api`, every endpoint that screen uses must exist there first (see
   "Missing from apps/api").
7. Add what the PR changes to `CHANGELOG.md` under "Unreleased".
8. In the PR description, list the database objects and endpoints it adds or changes, how it was tested, and paste
   the `pre-pr-check.sh` output.

Pulling `main` into a dev branch is how a branch catches up, and it's always allowed. Undoing or reworking what came
in from `main`, while resolving conflicts or later, needs Mike's approval first.
