# Release runbook: deploy and rollback

Written 2026-11-01 (QA 18, FIG-1251) from the repo. **Nothing below has been run against a hosted
project**: none is linked (there is no `supabase/.temp/project-ref`), and staging, a scripted deploy and a
restore drill are still open in `PRODUCTION_TODO.md`. Treat each step as a checklist to rehearse on the
first real release, then correct this file. Lines marked *(check)* are things this file could not verify.

## Before any deploy

1. The pull request is merged and CI is green, security scan first (`.github/workflows/ci.yml`).
2. Run the same checks on the commit you will ship: `npm run typecheck`, `npm run lint`, `npm run test:unit`,
   `npm run test:edge`, `sh scripts/run-rls-checks.sh` (needs the local stack, see README).
3. Write down what is live now, so you can go back to it: the git commit, the current Vercel deployment,
   and `supabase migration list` for the project (local column against remote column).
4. **Back up the database first**: dashboard, Database, Backups, or `pg_dump`. A backup you have never
   restored is a guess; see "Not covered" below.

## Deploy, in this order

The order matters because each step must find what the previous one made, and because for a few minutes
the new database runs under the old web app and old functions.

1. **Migrations**: `supabase db push`. Add `--include-all` when a migration's version is older than one already
   applied (it happens after merging branches). Keep every migration backward compatible with the code that is
   still live: add columns and tables in one release, remove or rename them in a later one. A new enum value
   cannot be used in the same transaction that adds it, which is why those migrations are two files.
2. **Secrets** the new code reads: `supabase secrets set NAME=value` (the Daraja keys and
   `DARAJA_CALLBACK_SECRET` are listed in `.env.example`).
3. **Edge functions**: `supabase functions deploy <name>` for each changed function. Five are public and
   must be deployed without JWT verification, as `supabase/config.toml` says: `mpesa-callback`,
   `signup-organization`, `search-schools`, `resolve-login-id`, `request-password-reset`. Every other
   function keeps the default check.
4. **Web**: merge to the branch Vercel deploys. *(check: which branch and project; `apps/web/vercel.json`
   holds only headers and caching.)*
5. **Phone apps** ship separately through the stores (`mobile-release-build.yml`), never in step with this
   list, so the database and functions must keep working for the old app versions in the field.

## After the deploy

Sign in on the hosted school as an admin, a teacher and a parent. Take and save one register, open the parent
Fees screen, and open Platform, System health, which runs `check-services`. Look at the edge function logs for
errors for ten minutes.

## Rollback, by layer

| What went wrong | Go back by | Cost |
|---|---|---|
| Web app | Promote the previous Vercel deployment *(check)*. No rebuild. | None |
| An edge function | Check out the previous commit and run `supabase functions deploy <name>` again. Functions hold no data. | None |
| A migration that is harmless but unwanted | Leave it in and roll the code back. | None |
| A migration that breaks something | Write a **new** migration that undoes it and `supabase db push` it. There are no down-migrations; never edit or delete a migration that has been applied. | Minutes |
| Corrupted or lost data | Restore the backup from "Before any deploy". Everything written since the backup is lost, so decide with the schools first. | Hours, and data |
| A phone app | You cannot recall a store build: halt the staged rollout in the store console and publish a fixed build with a higher `versionCode` (it is hard-coded to 1 today). | A review cycle |

Never run `supabase db reset` against a hosted project. It drops everything.

## Not covered yet

- **Restore drill**: BLOCKED until a production project separate from the demo one exists. Until a restore
  has been done once and timed, the backup step above is untested.
- **Staging**: no separate staging project, so every deploy rehearses on production.
- **Error reporting**: none. The web app has no error boundary and no error service, so a broken release is
  found by users, not by us (QA 18 found that a build without the Supabase settings shows a blank page).
- **Scripted deploy**: steps 1 to 3 are typed by hand.
