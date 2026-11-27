# Roadmap: connect the last web pages to the new API

Written 2026-11-25 against `dev-joe` at `97427202`. It replaces the status tables in `WEB-ON-API-TODO.md`, which are out of
date (they still say "8 of 97 pages"). The TODO's recipes and traps are still right.

**This file is the plan. It holds no status.** Status lives in the working notes and in each slice's PR. Slice PRs must not
edit this file: that is what made earlier PRs conflict. It is refreshed in a docs PR when a phase ends.

## 1. What is left: 16 pages

Counted from the code on 2026-11-25: the page registry in `apps/web/src/api/pages/` against the routes in `App.tsx`
(Supabase build) and on `main`. Of the 104 pages on `dev-joe` (88 school-side, 5 organisation, 10 platform, and
`/signup`), 95 are on the API build and 9 are not; 7 more exist only on `main`.

| # | Page | Why it is not on the API build | Slice |
|---|---|---|---|
| 1 | `admin/leave-to-approve` | To build (HR-run leave approvals; the HR handoff it needed is merged) | S4 |
| 2 | `teacher/loans` | **Closed by decision (D1, 2026-11-26):** stays hidden. A preview with sample data; no backend anywhere | S7 |
| 3 | `staff/loans` | **Closed by decision (D1, 2026-11-26):** same | S7 |
| 4 | `platform/curriculum` | **Closed by decision (D6, 2026-11-25):** each school verifies its own catalogue, as the API does | S5 |
| 5 | `platform/incidents` | To build (D5: keep a hand-typed list) | S5 |
| 6 | `platform/subscriptions` | To build (D3: the API owns Figbloom's billing of schools) | S5 |
| 7 | `platform/invoices` | To build (D3) | S5 |
| 8 | `platform/impersonation` | **Closed by decision (D4, 2026-11-25):** no impersonation page. (It was an empty log: nothing writes it.) | S5 |
| 9 | `/signup` | To build (D8: platform approves, rate-limited; D2: this API's console owns approval) | S6 |
| 10 | `admin/behaviour` | On `main` only. The API has nothing for it | S2 |
| 11 | `teacher/behaviour` | same | S2 |
| 12 | `parent/behaviour` | same | S2 |
| 13 | `student/behaviour` | same | S2 |
| 14 | `admin/hr` (HR & Payroll connect page) | On `main` only. No handoff on the API | S3 |
| 15 | `/hr/launch` (one-time sign-in into HR) | same | S3 |
| 16 | `admin/inventory/stock/:section` | On `main` only. The API has items and issues, not stock | S1 |

Not part of the 16, but needed before the production switch, and planned in section 8: the controls hidden on pages that
are already connected (179 capability flags across 28 areas), and two live features the API lacks (M-Pesa allowlist and
retry, section 8).

## 2. Rules every slice follows

These come from `CLAUDE.md`, `.agents/SECURITY.md`, `CHANGELOG.md` and the owner's standing instructions.

- **Security first.** Run `sh scripts/security-scan.sh` before any build, lint, test run or commit. A match is a stop: tell the
  owner, change nothing.
- **Worktree per slice**, under `C:\Users\Admin\Desktop\Projects\sms-wt\<name>`, branch off `origin/dev-joe`. The main
  checkout stays on `dev-joe`, clean.
- **One slice per PR, into `dev-joe`, squash.** The owner merges. Never merge, approve or enable auto-merge. Push the
  branch, then open the PR.
- **`main` is production.** Read `CHANGELOG.md` in full before touching `supabase/` or `apps/api/`. Do not remove, rename or
  change anything it lists as live. Pulling `main` in is always allowed; undoing or reworking what came in from `main`
  needs Mike's approval first. Add what a PR changes to `CHANGELOG.md` under "Unreleased".
- **A port keeps the live rules.** Where a feature is live on Supabase (behaviour log, stock, HR), the API version follows
  the same rules, as `CHANGELOG.md` states them. It is a port, not a second design.
- **API changes** go in their own PR, before the web slice that needs them. Forward-only numbered migrations (115 to 118
  are taken by open PRs #422, #425, #423 and #424; take the next free number above what is on `dev-joe` and the open PRs, and
  check `gh pr list` first). Every tenant table has forced RLS plus a `figbloom_app` policy. Minimal grants. Permissions through
  `requirePermission`. Update OpenAPI, then `npm run api:types`. Every new `throw new Error(` goes in the
  `errors.inventory` test. Negative authorisation tests come before positive ones. Start each API slice with a short design
  note in `apps/api/docs/`.
- **Web slices** keep the screen and change the shared function under it: `if (onApi()) return <area>Api.fn(...)`, the API
  side in `packages/shared/src/api/`, a flag in `capabilities.ts` for each missing endpoint, the page registered in
  `apps/web/src/api/pages/<area>.pages.tsx`, and the write-up in `docs/web-on-api/<area>.md` (findings numbered
  `<area>-N`). Do not edit `ApiConsole.tsx` or another area's doc.
- **Shared code passes the phone's typecheck** (no bare `window`, `document` or `crypto`).
- **Checks (the owner chose lighter checks on 2026-11-24).**
  - tsc for shared, web, web tests, mobile and mobile node tests; `eslint .`; vitest (new files, then the full run).
  - For API slices: the new tests plus the permission registry, RBAC matrix, grants matrix, RLS catalogue, definer
    inventory, OpenAPI drift and `errors.inventory` tests. CI runs the full API suite.
  - One quick browser pass against a throwaway API (recipe in `WEB-ON-API-TODO.md`). If a shared module the Supabase build
    uses changed, a read-only pass of that build too.
  - No mutation testing, no long scripted browser sessions, no new e2e specs.
- **Hands off:** the owner's dev server on `:5173`, the `supabase_db_figbloom` database as a test target, the
  `figbloom-operations` stack, production, any AWS resource.
- **Linear:** the owner updates it. Each slice ends with paste-ready text. Leave the FIG id out of partial slices' PR titles.
- **Limits:** at most 2 background agents and about 5 local stacks at once. Pick ports that are free at the time.

## 3. What "done" means for a page

A page is done when **one** of these holds:

1. **Connected.** It opens from the API build's menu. Everything it shows comes from `apps/api`. Every control works, or is
   hidden with a written reason. It has unit tests, one browser pass, and an entry in `docs/web-on-api/`.
2. **Closed by decision.** The owner decided it should not exist on the API build (or not exist at all). It is hidden with a
   written reason, and the decision is recorded in its area's doc.

The roadmap is finished when all 16 are done in one of these two ways, and the owner has agreed the list.

Two things "done" does not mean:

- **Not switched on for real schools.** The HR pages (S3, S4) are built and tested against a fake platform and HR. Using
  them with a real school needs the owner's answers on ids, credentials and network (section 6), and a real check on a test
  school. That check is the owner's, and the slices say so.
- **Not the production switch.** That waits for section 8.

## 4. Order of work

Two tracks that touch different files, so they run side by side.

```
Web track:  P1 sync main ──► S1c stock web ──► S3 H2 ──► S4 L2 ──► S2c ──► S2d ──► (decisions) ──► S5 / S6
API track:  S1a ► S1b ► S3 H1 ► S4 L1 ► S2a ► S2b ► (decisions) ► S5 / S6 API
```

1. **P1** first: seven of the 16 pages exist only on `main`.
2. **S1** (stock) next: closest to code that is already on the API (inventory items and issues).
3. **S3, S4** (HR) while the HR owner questions are answered: they build against fakes and need no credentials.
4. **S2** (behaviour) last of the big ones: the largest slice (four PRs, new tables).
5. **S5, S6** as the owner's decisions arrive. The cheap ones first (incidents).
6. **Close-out:** re-run the page count, update `WEB-ON-API-TODO.md` and `CHANGELOG.md`, hand over Linear text.

Expected after the decisions of 2026-11-25 (billing built; impersonation and curriculum closed): about 22 PRs (P1 1, S1 4,
S2 4, S3 2, S4 2, S5 about 6, S6 2, docs 2).

## 5. Slices

### P1. Bring `main` into `dev-joe` (branch `sync/main-into-dev-joe`)

- **Why:** `main` has 24 commits (117 files) that `dev-joe` lacks. Items 10 to 16 live there.
- **Do:** `git merge origin/main` in a worktree. 30 files changed on both sides:
  - web: `App.tsx`, `ConsoleShell.tsx`, `lib/useSession.ts`; the screens People, Fees, Inventory, Medical, Fleet,
    Announcements, Chats; parent Bus, Fees, Home; teacher Buses; medical modals;
  - shared: `adminAreas.ts`, `guide.ts`, `index.ts`, `inventory.ts`, `mpesaPay.ts`;
  - repo: `package.json`, `vercel.json`, `.env.example`, CI, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
    `scripts/pre-pr-check.sh`.
- **Rule:** `main`'s behaviour stays. Where both sides edited a function, keep `main`'s lines and put the `onApi()` branch
  around them. Do not rework what came from `main`. If a conflict can only be solved by doing that, stop and ask Mike.
- **Hidden conflicts:** check what git does not show: a function both sides changed in different places, a renamed import,
  the `NAV` entries `main` adds (behaviour for four roles, the HR item). On the API build they must stay hidden until their
  slice lands (`hiddenNav` hides every `NAV` entry not registered).
- **Checks:** all section 2 checks, both Vite builds, and a look at the API build's menus.
- **Exit:** PR green. The owner merges. Slices S1c, S2c, S2d and S3 H2 start after.

### S1. Inventory stock (page 16, and the AI `stock_insights` task)

- **S1a API:** design note `apps/api/docs/INVENTORY-STOCK.md`. Migration: `unit`, `consumable`, `reorder_level` on
  `inventory_items`; `inventory_movements` (received, used, wasted, adjusted; the trigger that keeps levels). Routes: record
  and list movements, stock levels. Same rules as `20261124200000_inventory_movements.sql` on `main`.
- **S1b API:** the reports: ledger, usage, spend by month, cost per meal, headcount, consumption flags (last 8 weeks, as
  `main` has it after #390). `stock_insights` on `/ai/query`: the caller sends a period only; the answer has item names and
  numbers, never people. **Not built (found while building S1b):** the Bloom contract `bloom-school/1` is chat only (no
  instructions, no output schema, 4,000-character prompts, no per-school metering), so it cannot carry the figures. It needs a
  new capability in a new contract version with about 64 KiB of server-built context and a JSON answer schema. It stays hidden
  on the API build until the owner decides to ask for that.
- **S1c web (after P1):** API branches in `inventoryStock.ts` and `inventoryPaging.ts`; register the stock pages in
  `inventory.pages.tsx`; flip the `INVENTORY_ON_API` flags the API now backs; extend `docs/web-on-api/inventory.md`.
- **Size:** L, three PRs.

### S2. Behaviour log (pages 10 to 13)

- **Rules to keep** (from `CHANGELOG.md`): points mode per school (merits only, demerits only counted down from a starting
  balance, or both); reset per term, per year or never; any teacher of the learner may record an entry; the office manages
  it through a new `discipline` area; parents see merits always, demerits and incidents only if the school allows, staff-only
  notes never; entries are voided with a reason, never deleted; an incident has an action, a follow-up status and a "parent
  told" flag; recording notifies the family; a school gets default categories.
- **S2a API:** design note `apps/api/docs/BEHAVIOUR.md` (permissions, who reads what, family access following
  `FAMILY-READS.md`). Migration: `behaviour_settings`, `behaviour_categories`, `behaviour_entries`, `behaviour_staff_notes`,
  all with forced RLS and audit. Routes: settings, categories (create, edit, archive, defaults), record (several learners
  at once), list with filters, void, points.
- **S2b API:** incidents and follow-up, staff-only notes, the family notification, the family reads for a parent
  (`/me/children/{id}/behaviour`) and for a learner's own record.
- **S2c web:** `behaviour.ts` API branch; `admin/behaviour` and `teacher/behaviour` in a new `behaviour.pages.tsx`;
  capability flags; `docs/web-on-api/behaviour.md`.
- **S2d web:** `parent/behaviour` and `student/behaviour`.
- **Size:** XL, four PRs.

### S3. HR handoff and the connect page (pages 14 and 15)

Follows `apps/api/docs/HR-HANDOFF.md` (slices H1, H2) and `CHANGELOG.md` ("HR and Payroll: connect page").

- **H1 API:** status, request and open through the My HR platform client (merged in #410); `PLATFORM_HANDOFF_ENABLED`;
  `hr_requested_at` and `hr_requested_by` on `GET /v1/platform/schools`; permission, audit, tests against the fake platform.
  The one-time URL is never logged.
- **H2 web:** `onApi()` branches in `hrHandoff.ts`; `admin/hr` and `/hr/launch` on the API build; the menu item only while
  the API says HR is available.
- **Size:** M and M.
- **Gate:** section 6, decision D7. Built and tested against fakes either way.

### S4. Leave to approve (page 1)

- **L1 API** (after H1): approvals list and decide, permission `resource.hr.leave_approvals`, audit, tests.
- **L2 web:** `admin/leave-to-approve` ("connect once" message, document links opened only when `https` and fresh).
- **Not in the 16, and a hard rule:** L3 (staff apply in HR) and L4 (inbound events) must exist before `HR_LEAVE_ENABLED`
  is switched on for any school, because that switch moves the whole school's leave to HR. Plan them after the 16.
- **Size:** M and M. **Gate:** D7.

### S5. Platform pages (pages 4 to 8)

The owner answered four of these on 2026-11-25:

| Page | The owner said | Work |
|---|---|---|
| `incidents` | D5: keep a hand-typed list | `platform_incidents` table, 3 routes, the page. Size S |
| `subscriptions`, `invoices` | D3: the API owns Figbloom's billing | plans, prices, trial and renewal fields, `platform_invoices`, permissions, audit, re-auth on money changes. Size L each |
| `curriculum` | D6: each school verifies its own | none: **closed by decision** (the API already works this way) |
| `impersonation` | D4: no impersonation | none: **closed by decision**. The open "a super admin can act in any school with full powers and no record the school can read" stays a separate question to decide |

Also from the same note, on the connected Tenants page and not in the 16: suspend, reactivate and move between
organisations (Q1).

### S6. Sign-up (page 9)

- **API:** a public, rate-limited route that creates an organisation in `pending` with its first admin's invitation (e-mail
  goes through Resend, in since #353). Approval through `platform/organizations`.
- **Web:** `/signup` on the API build, with the slug check on the public school lookup (#414).
- **Decisions (2026-11-26):** D8: Figbloom staff approve or reject on `platform/organizations`; the public route is
  rate-limited with an e-mail check. D2: this API's console owns approve and reject. The owner added that API schools and
  organisations should also be seen in `console.figbloom.org`. That needs that console's contract (which events it expects
  and which ids), which we do not have, so it is **not built** and is written up as a finding in `docs/web-on-api/signup.md`.
- **Size:** L, two PRs.

### S7. Loans (pages 2 and 3)

No backend exists on either build. **Closed by decision (D1, 2026-11-26):** they stay hidden, and the reason is written in
`docs/web-on-api/staff-shell.md`. If the owner wants Loans built, that is a new product and needs a spec first; it is not a
port.

## 6. Decisions I need from the owner

I do not decide product questions. A slice that reaches its gate without an answer is **parked** and I carry on with the
others. Each line has my suggested answer; "no default" means I would not guess.

| ID | Question | Pages | Suggested answer |
|---|---|---|---|
| D1 | Do Loans stay hidden? | 2, 3 | **Answered 2026-11-26: yes, keep them hidden** |
| D2 | Q1: which console owns school and organisation lifecycle on the API? | Tenants controls, 9 | **Answered 2026-11-26: this API's console, "but also seen in console.figbloom.org".** The first part is built (approve and reject, S6; suspend and reactivate later). The second needs that console's contract and is open |
| D3 | Q2: does the API own Figbloom's billing of schools? | 6, 7 | **Answered 2026-11-25: yes, build it.** (Today staff mark invoices paid by hand, and there is no gateway) |
| D4 | Q3: should impersonation exist? | 8 | **Answered 2026-11-25: no.** Still open: whether a super admin keeps full powers inside any school |
| D5 | Q4: keep a hand-typed incident list here? | 5 | **Answered 2026-11-25: yes, keep it** |
| D6 | Q6: does Figbloom verify one curriculum catalogue for all schools, or each school its own? | 4 | **Answered 2026-11-25: each school verifies its own** |
| D7 | HR: ids, credentials, network, contracts, who sees the pages, approvals-only first (`HR-HANDOFF.md` section 6, questions 2 to 5, 7, 8, 9, 13) | 1, 14, 15 | Needed to switch on for a real school. Not needed to build. Suggested: leave documents out of L3 first |
| D8 | Sign-up: who approves a new organisation, and what stops abuse? | 9 | **Answered 2026-11-26: the platform approves on `platform/organizations`; the public route is rate-limited with an e-mail check** |

## 7. How I work through it

1. Start with P1 and S1a together. Start S3 H1 when a second agent slot is free.
2. Per slice: worktree, security scan, design note (API) or capability flags (web), tests first for authorisation, code,
   checks, one browser pass, `docs/web-on-api/<area>.md`, `CHANGELOG.md` entry, push, open the PR into `dev-joe`.
3. When the owner merges a PR, bring `dev-joe` into every open slice branch (merge, no force-push) before the next PR.
4. Every report ends with the same table: 16 pages, each `done`, `in PR`, `in progress`, `parked (decision)` or `closed by
   decision`, with the PR numbers, what was verified, what was not, and paste-ready Linear text.
5. **I stop and tell the owner** when: the security scan matches; a conflict needs `main`'s behaviour undone (Mike); a test
   fails and I cannot explain it; a step would touch production or AWS; or a usage limit is reached. I do not work around any
   of these.

## 8. After the 16 (needed before the production switch)

The production site moves to `VITE_BACKEND=api` only when every page is on the API (the owner's rule). These are not part of
the 16, and each needs its own plan when the 16 are done.

- **Hidden controls on connected pages: 179 capability flags in 28 areas.** Most come from four causes:
  - **File storage.** `files.ts` has no API branch, so homework, materials, exam-paper, chat and payment-proof files, and
    photos, are hidden.
  - **Missing edit and delete endpoints:** classes, subjects, exams, homework, materials, papers, activities, items.
  - **Signatures** (C12) and **voice calls and live classes** (C13).
  - **Controls the API has no read for yet** (many student and parent controls).
- **Live on Supabase, missing from the API** (from `CHANGELOG.md`): the M-Pesa `DARAJA_TENANTS` allowlist and the retry when
  Daraja answers 429; check the API's own RLS never checks rights per row.
- **HR leave L3 and L4** (section 5, S4).
- **Release readiness** for `dev-staging` and `main`: `sh scripts/pre-pr-check.sh`; rename the `20261106*` migrations to
  after the newest on `main`; restore `20261110160000_group_present_today_counts_late.sql` to `main`'s version and move the
  reconciliation into a new migration (both in `CHANGELOG.md`, "Catching up with main"). These need Mike's approval.
