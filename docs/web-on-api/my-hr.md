# My HR on the API build

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file. Written 2026-11-25.

My HR (`teacher/my-hr`, `staff/my-hr`, `admin/my-hr`: one screen, `screens/myhr/MyHr.tsx`) shows a staff member's own payslips,
leave, attendance and KPIs from Figbloom HR (bloomHR). On Supabase the screen calls the `my-hr` edge function. On the API build it
calls the API's HR proxy, `GET /v1/tenants/{tenantId}/me/hr/*` (`apps/api/docs/MY-HR.md`). **The proxy is off by default**, so the page
stays hidden on the API build until the owner adds the secrets and links schools. Nothing here was tried against a real HR.

## What works

- The screen is unchanged. `fetchMyHrStatus()`, `fetchMyHr(route, params)` and `fetchPayslip(id)` in `packages/shared/src/myHr.ts` keep
  their signatures and now branch on `onApi()` to `packages/shared/src/api/myHrApi.ts`. HR's JSON comes back as HR sent it, so
  `readSummary`, `readPayslips`, `readLeave`, `readAttendance` and `readKpis` read it as before.
- The API's refusals become the `EdgeError`s the screen already reads. `not_linked` and `pending_hr` keep their code, so the "Your HR record
  isn't ready yet" card shows with the API's sentence. Every other refusal shows the API's own sentence ("HR & Payroll can't be reached right
  now. Try again in a minute.", "Figbloom HR isn't connected to this school yet. Ask Figbloom.", and so on).
- Payslips open on the page and print from HR's figures (HR has no server-side PDF), as on Supabase.

## When the page shows

The API's status says one of `not_staff`, `off`, `not_linked`, `not_enabled`, `available` (the rule of `my_hr_status()`, see the API doc).
The page shows only for `available`, and it is closed twice:

- **The menu entry.** The shells of the API build list their pages statically (`api/ApiConsole.tsx`), so they cannot hide an entry for one
  person. `ConsoleShell` already holds per-entry rules (Visitors, the study helper, the bus pages), so My HR got one more: on the API build
  it asks `useMyHrStatus` and hides `*/my-hr` until the answer is `available` (`lib/myHrNav.ts`). In the admin console the entry is for the
  school's own administrator only (not a teacher or other staff member who holds admin areas, and not an organisation administrator acting for
  the school), as in `App.tsx`. On a Supabase build the rule does nothing: `App.tsx` hides it itself.
- **The address.** `my-hr.pages.tsx` registers the three pages, each inside `MyHrGate` (`api/pages/MyHrGate.tsx`): a skeleton while the status
  is read, and for any answer but `available` (or a status that cannot be read) the person is sent to their console's home.

`ApiConsole.tsx`, `pages/index.ts` and `pages/types.ts` are not edited: the registry picks `my-hr.pages.tsx` up.

## What is hidden and why

| Hidden or different | Why |
|---|---|
| My HR, for everyone, until the owner switches the API's HR proxy on and links schools | off by default (owner's decision, Nov 25): needs the platform and HR settings and a row in `platform_school_links` per school |
| A driver has no My HR entry | the driver's console is its own set of pages (`ApiDriver.tsx`), with no My HR on either build. The API serves a driver's HR record, so adding one later needs no API change |
| Apply for leave, cancel it, approve it, and the HR & Payroll hand-off | not in this slice (`admin/leave-to-approve` and the HR parts of `teacher/leave` stay hidden: C13) |
| Loans (`staff/loans`, `teacher/loans`) | **no backend on either build.** `staff/Loans.tsx` is a preview: it saves nothing and shows made-up history and a fixed borrowing limit. It is not an HR matter. Hidden by the owner's decision on Nov 25 |

## Where the code is

- `packages/shared/src/api/myHrApi.ts`: the three calls and the error mapping. `packages/shared/src/api/errors.ts` knows the new error codes.
- `apps/web/src/api/pages/my-hr.pages.tsx` and `MyHrGate.tsx`: the registered pages and the address gate.
- `apps/web/src/lib/myHrNav.ts` and one rule in `apps/web/src/components/ConsoleShell.tsx`: the menu entry.
- Tests: `packages/shared/src/api/myHrApi.test.ts` (fake API: every state, each route, each refusal) and `apps/web/src/lib/myHrNav.test.ts`.

## API findings: My HR (numbered `my-hr-1` and so on so that no other slice shares a number)

my-hr-1. **The ids HR knows are the Supabase ids.** HR links a school by its Supabase `tenants.id` and a person by their Supabase `profiles.id`.
    The API sends its own ids, and a school copied with `scripts/supabase-to-api` gets new ones, so such a school will see "Figbloom HR
    isn't connected to this school yet" (HR's `school_not_linked`) or "Your HR record isn't ready yet" (`not_linked`) even when HR is set up
    properly. Open question for the owner (Q1b in `apps/api/docs/MY-HR.md`): HR links the new ids, or the API keeps the old ones.

my-hr-2. **Nobody registers a school with the platform on the API yet.** There is no `platform-sync` (`PLATFORM-CONSOLE.md`, Q1). Until the owner
    decides, an operator links each school with one SQL statement (API doc, "Linking a school"). Nothing in the API records that HR is not on
    for a school (Supabase learns it from the hand-off), so a linked school reads `available` and HR answers per call.

my-hr-3. **The status is a few small requests per page load.** `useMyHrStatus` keeps an answer for 60 seconds per person, but only once it has
    arrived, so the shell, the gate and the screen each ask on a fresh load (2 to 4 calls seen in the browser pass). Each is answered from the
    database only. Sharing one in-flight request in `useMyHr.ts` would make it one.

my-hr-4. **A teacher who holds admin areas has no teacher console on the API build**, so their My HR entry (a teacher entry) is not in their menu:
    the page is reachable by address (`teacher/my-hr`) and gated the same way. This is the same gap every teacher page has for them; it closes
    when the console switch for teachers is built.

my-hr-5. **HR's answers are passed through, not described.** The API documents them as "an object with any fields" (`MyHrAnswer`), so the client
    types them `unknown` and the readers in `myHr.ts` tolerate missing fields, as they did on Supabase.

## What was verified, and what was not

Verified:

- Unit tests: `myHrApi.test.ts` (14: every state, each route, each refusal) and `myHrNav.test.ts` (4), with the neighbouring My HR, errors, leave and
  staff tests (69 in all); typecheck of shared, web, web tests and mobile.
- One browser pass (Edge, headless) against a throwaway API (Postgres 16 container, the API built from the API branch, migrated, seeded) and a fake
  HR on this machine: **off** (nothing set): the teacher has no My HR entry and the address goes back home (3 checks). **On**, school linked: the
  teacher's entry, her summary, the three payslips, one payslip laid out from HR's figures, the leave, attendance and KPI tabs, no script errors; a
  staff member's and the school admin's entries (and the admin's page); a school with no link has no entry and its address is closed (14 checks).
  **Link removed**: the entry is gone and the address is closed (2 checks).
- The Supabase build against the local demo (read only): the admin console loads, My HR is hidden by that build's own shell, the page by address
  shows its own note, no script errors and no `my-hr` function call (4 checks).

**Not** verified: anything against a real HR, a real platform or real credentials (none were used); the page with real HR data; the phone app (it
compiles against the shared code and has no My HR screen).
