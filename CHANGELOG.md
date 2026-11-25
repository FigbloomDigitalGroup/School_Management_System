# Changelog

What is live in production for the School Management System, and what every branch has to keep working.

`main` is production. If a feature is listed here, schools are using it today. Your branch must not remove it,
rename it or change how it behaves without a PR that Mike approves.

## Rules for every branch

1. **Bring `main` into your branch before you build on it.** `dev-staging` and `dev-joe` are missing everything
   under [2026-11-24](#2026-11-24) below. Merge `main` in first (see
   [Catching up with main](#catching-up-with-main)).
2. **Don't rebuild something that is already live.** Check this file first. If what you need is close to something
   here, extend it instead of writing a second version.
3. **Database objects listed here are a contract.** Don't drop, rename or change the arguments or returned columns
   of these tables, functions or policies. Add new ones next to them instead. If one really has to change, say so in
   the PR description and add a line to this file.
4. **New migrations get a timestamp later than the newest one on `main`.** The newest on `main` is
   `20261124400000_behaviour_log.sql`, and `20261124500000` is taken by open PR #393. A migration dated earlier than
   one already applied in production is skipped or refused when we deploy.
5. **New row-level security policies use the once-per-query helpers** (`my_perm_tenant_ids`, `my_office_tenant_ids`,
   and the others under [RLS: once per query](#rls-work-out-rights-once-per-query-not-once-per-row-374)). Don't call
   `has_perm` / `has_office_perm` per row. That is what made the bursar's Fees page time out.
6. **The new API (`apps/api`, being built on `dev-joe`) has to cover every endpoint here before the web app moves
   onto it.** [Missing from apps/api](#missing-from-appsapi-on-dev-joe) lists what it doesn't cover yet.
7. **Every change to live behaviour adds an entry to this file** in the same PR, under
   [Unreleased](#unreleased). Mike moves it to a dated section when it goes live.

## Unreleased

On `main` or in an open PR, not live in production yet.

- **Attendance fixes (FIG-1406, FIG-1407, FIG-1408)**: on `main` since 2026-11-10 but **left out of production on
  purpose** until they're reviewed. Production doesn't have these migrations yet:
  - `20261110160000_group_present_today_counts_late.sql`
  - `20261110170000_attendance_class_is_learners_class.sql`
  - `20261110180000_attendance_follows_class_moves.sql`
  - `20261110190000_register_keeps_original_taker.sql`

  Code on your branch must work **with and without** them.
- **Bus tick change (FIG-770, `48118fe`)**: on `main`, not deployed. Production `bus-tick` is still at `9d5e572`.
- **#393 Performance round 2** (open): migration `20261124500000_perf_round2.sql` for activities, stock analytics,
  `my_students` and the remaining per-row checks. Database only.
- **#390 Stock flags and paging** (open): stock flags always use the last 8 weeks, failed sections retry, and paging
  resets before refetching. Web only. Held back until after the 2026-11-25 demo.

## 2026-11-24

Everything here is live in production: database migrations, edge functions (on both AWS Lambda and the database
server's edge runtime), and the web app on Vercel. **None of it is on `dev-staging` or `dev-joe` yet.** Both
branches split from `main` at `c15189a` (PR #322, 2026-11-13).

### Behaviour and discipline log (#378)

Merit and demerit points that each school sets up.

- **Migration**: `20261124400000_behaviour_log.sql`
- **Tables**: `behaviour_settings`, `behaviour_categories`, `behaviour_entries`, `behaviour_staff_notes` (all with
  RLS and audit triggers)
- **Functions (RPC)**:
  - `record_behaviour(p_student_ids uuid[], p_kind text, p_category_id uuid, p_points int, p_note text, p_staff_note text, p_occurred_on date, p_subject_id uuid, p_severity text) returns int`
  - `void_behaviour_entry(p_id uuid, p_reason text)`
  - `set_behaviour_incident(p_id uuid, p_action text, p_status text, p_parent_notified boolean)`
  - `add_default_behaviour_categories(p_tenant uuid) returns int`
  - `behaviour_period(p_tenant uuid, p_reset text, p_on date)`
  - `behaviour_points(p_student_ids uuid[], p_on date)`
  - `my_taught_student_ids()`, `my_behaviour_family_kinds()`, `is_admin_area(p_area text)`
- **Triggers**: `behaviour_entry_prepare` (before insert), `behaviour_entry_notify` (after insert, notifies the
  family)
- **New admin area**: `discipline` (`packages/shared/src/adminAreas.ts` and
  `supabase/functions/_shared/adminAreas.ts`)
- **Rules**:
  - Points mode per school: merits only, demerits only (counted down from a starting balance), or both.
  - Points reset per term, per year or never.
  - Any teacher of the learner can record an entry. The office manages it through the `discipline` area.
  - Parents see what the school allows: merits always, demerits and incidents only if the school turns them on,
    staff-only notes never.
- **Shared code**: `packages/shared/src/behaviour.ts`
- **Screens**: `admin/Behaviour.tsx`, `teacher/Behaviour.tsx`, `parent/Behaviour.tsx`, `student/Behaviour.tsx`
- **RLS checks**: `supabase/rls-checks/behaviour_log.sql`

### RLS: work out rights once per query, not once per row (#374)

A performance fix with no change in who can see what. The bursar's invoice list went from 2,261 ms to 8 ms in
production.

- **Migration**: `20261124300000_rls_once_per_query.sql`
- **New set-returning helpers**, which are now the way to write policies:
  - `my_administered_tenant_ids()`
  - `my_perm_tenant_ids(p_area text)`
  - `my_office_tenant_ids()`
  - `my_guardian_student_ids()`
  - `my_teaching_pairs()` returns `(class_id, subject_id)`
- **Policies rewritten** (same rules, new helpers) on `students`, `fee_invoices`, `payments`, `payment_proofs`,
  `fee_items`, `classes`, `guardians`, `profiles`, `attendance`, `marks`, `cbe_results`, `cbe_assessments`, `exams`,
  `teaching_assignments`, `mark_publications`, `inventory_items`, `inventory_issues`, `inventory_movements`,
  `sick_bay_visits`, `visit_medications`.
- **Important for branches**: a migration on your branch that re-creates any of these policies the old way undoes
  this fix. Redo it with the helpers above.
- **RLS checks**: `supabase/rls-checks/rls_once_per_query.sql`

### Inventory: stock in and out, stock overview, flags and AI insights (#360, #375)

- **Migration**: `20261124200000_inventory_movements.sql`
- **New columns on `inventory_items`**: `unit` (text), `consumable` (boolean, default false), `reorder_level` (int)
- **New table**: `inventory_movements`
  - `kind`: `received`, `used`, `wasted` or `adjusted`
  - other columns: `quantity`, `unit_cost_cents`, `supplier`, `reference`, `occurred_on`, `purpose`, and meals
    served
  - The `inventory_movements_apply` trigger keeps stock levels up to date.
- **Functions (RPC)**, all granted to `authenticated`:
  - `inventory_ledger(p_tenant_id, p_from, p_to)`
  - `inventory_usage(p_tenant_id, p_from, p_to, p_bucket default 'week')`
  - `inventory_spend_by_month(p_tenant_id, p_from, p_to)`
  - `inventory_cost_per_meal(p_tenant_id, p_from, p_to, p_bucket default 'month')`
  - `inventory_stock_levels(p_tenant_id, p_as_of default current_date)`
  - `inventory_headcount(p_tenant_id, p_from, p_to)`
  - `inventory_consumption_flags(p_tenant_id, p_from, p_to)`
  - `inventory_price_on(p_item_id, p_day)`, `inventory_qty_text(p_qty, p_unit)`, `inventory_may_read(p_tenant_id)`
- **New AI task `stock_insights`** in `ai-assist`: the caller sends only a period. The function reads the figures
  with the caller's own rights, and the result contains item names and numbers, never people. The
  `ai_usage_task_check` constraint now allows it.
- **Shared code**: `packages/shared/src/inventoryStock.ts`, `inventoryPaging.ts`
- **Screens**: `admin/InventoryStock.tsx`, `InventoryStockPages.tsx`, `InventoryFlags.tsx`, `InventoryTrends.tsx`,
  `inventoryStockData.ts`
- **#375 web**: lists are paginated and cached (Fees through `packages/shared/src/feesPaging.ts`), and the stock
  overview widgets open their own pages with charts.
- **RLS checks**: `supabase/rls-checks/inventory_movements.sql`

### M-Pesa: per-school allowlist, confirmation retry and the "check" action (#366, #372)

- **`mpesa-stk-push`**:
  - **New action** `{ "action": "check", "payment_id": "<id>" }`, which answers `{ payment_id, status }`. The paying
    app calls it about every 15 s while it waits. Daraja is only asked about prompts at least 20 s old, at most 6
    times a minute per payment. Anyone who can read the payment may call it. It never sends a new prompt.
  - **`DARAJA_TENANTS`** (function setting): when it's set, only those schools can raise a prompt or be credited.
    Every other school gets the same `503 "M-Pesa payments aren't set up for this school yet."` as a school with no
    M-Pesa settings. In production it is set to the Kijani Ridge demo school only, on the Daraja sandbox.
  - If an earlier prompt turns out to be paid, it is now settled right away and the endpoint answers `409`.
- **`mpesa-callback`**: when Daraja's STK query is busy (429), the confirmation is retried with backoff.
- **New shared helpers**:
  - `supabase/functions/_shared/mpesaSettle.ts`: `settleFromDaraja`, the one place a payment is settled, used by
    both functions.
  - `_shared/daraja.ts`: `darajaTenants`, `tenantMayUseDaraja`, retrying `queryStk`.
- **Shared code**: `packages/shared/src/mpesaPay.ts`
- **Warning**: the Daraja sandbox took **real money** from a real phone in testing. Never describe it as free.

### HR and Payroll: connect page, Request Figbloom HR, open HR in a new tab (#355)

- **Migration**: `20261124100000_hr_request.sql`
  - **New columns on `tenants`**: `hr_requested_at`, `hr_requested_by`
  - **New function**: `platform_record_hr_request(p_tenant_id, p_profile_id)`
  - **Changed function**: `platform_console_schools(p_school_id)`, which now returns the HR request for the
    console. Service role only.
- **`open-hr`**: takes `POST {"tenant_id", "action"?: "open" | "status" | "request"}`
  - `status` returns `{enabled, connection, requested_at, can_request_hr}`. `connection` is one of `not_connected`,
    `setting_up`, `connected` or `unknown`.
  - `request` returns `{requested_at}` and records the school's request for HR. It answers `409 already_connected`
    if HR is already on.
  - `open` (the default) returns `{url, expires_at}`, a one-time sign-in link into HR.
- **`platform-schools`**: the console now sees the HR request.
- **`_shared/platformClient.ts`**: new `getTenantModule(id, module)` and `getTenantLink(id, module)`.
- **Screens**: `hr/HrLaunch.tsx`, `HrLaunchView.tsx`, `HrPayroll.tsx`, `HrPayrollViews.tsx`
- **Shared code**: `packages/shared/src/hrHandoff.ts`
- **RLS checks**: `supabase/rls-checks/hr_request.sql`

### Demo seeders (#365)

- `supabase/seed-kijani-full.ts` and `supabase/seed-kijani-behaviour.ts` fill the Kijani Ridge demo school.
- Both are idempotent, touch only Kijani, and use `@kijaniridge-demo.invalid` addresses. Nothing they create sends
  SMS, email or push.
- Don't point them at any other school.

## Missing from apps/api on dev-joe

Checked against `dev-joe` on 2026-11-25. The new API has to cover these before the web app uses it for these
screens:

| Live feature | What `apps/api` has | What's missing |
|---|---|---|
| Behaviour log | Nothing | All of it: settings, categories, recording, voiding, incidents, points, staff notes, family view |
| Inventory stock | `items` and `issues` routes | Stock movements (in, used, wasted, adjusted), `unit` / `consumable` / `reorder_level`, the ledger, usage, spend, cost per meal, stock levels, headcount and flags reports |
| AI stock insights | `ai/query` | The `stock_insights` task |
| M-Pesa | STK push and query in `finance.ts`, callback in `mpesa.ts` | The `DARAJA_TENANTS` allowlist, and retrying the STK query when Daraja answers 429 |
| HR and Payroll | Nothing | `status`, `request` and `open` (the `open-hr` function) |
| Console: HR requests | `GET /v1/platform/schools` | `hr_requested_at` / `hr_requested_by` |
| RLS performance | Its own RLS (`apps/api/migrations`) | Make sure the new policies don't check rights per row either |

## Catching up with main

`dev-staging` and `dev-joe` are 16 commits (8 PRs) behind `main`. To bring them up to date:

```bash
git checkout dev-joe && git pull
git checkout -b fix/bring-main-into-dev-joe
git pull origin main          # fix any conflicts here
git push -u origin fix/bring-main-into-dev-joe
gh pr create --base dev-joe --title "Bring main into dev-joe" --body ""
```

Do the same for `dev-staging`, with the PR going into `dev-staging`. That PR needs Mike's approval.

Before you merge, check these things your branch has that clash with `main`:

- **Early sign-out and afternoon attendance migrations** (`20261106000000`, `20261106000100`, `20261106000200` and
  `20261106060000`) are dated **before** migrations that are already live. Rename them to a timestamp after the
  newest on `main` (see rule 4) before they go to `main`.
- **New attendance policies** (`attendance_settings_*`, `attendance_afternoon_*`) should use the helpers from #374.
- **`term_class_figures`** is re-created by your migrations. Make sure it still works with the four pending
  attendance migrations above, both with and without them.

## Earlier history

Everything before 2026-11-13 is shared by `main`, `dev-staging` and `dev-joe`. See `git log` and the merged PRs on
GitHub.
