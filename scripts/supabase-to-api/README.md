# Supabase to apps/api: copy a school's records

A one-off tool that copies schools from the Supabase system into the new API (`apps/api`). It reads Supabase
directly (read only) and writes to the API **over its HTTP endpoints, never SQL**, so the API's tenant,
permission and audit rules apply to every record.

It handles real people, children among them. Everything it writes (the snapshot, the ledger, the reports, the
invitation tokens) goes in folders you choose **outside this repository**; both scripts refuse a folder inside it.

## What it does, in two steps

```
# 1. Read. SOURCE_DATABASE_URL should be a READ-ONLY role on the Supabase database.
SOURCE_DATABASE_URL=postgresql://... node scripts/supabase-to-api/extract.mjs --out <snapshot dir> [--school <slug>]...

# 2a. Plan. Sends nothing. Prints what would be created and every record the API would refuse, with the reason.
node scripts/supabase-to-api/load.mjs --snapshot <snapshot dir> --state <state dir> [--overrides fixes.json] [--school <slug>]...

# 2b. Apply. API_BASE_URL, API_EMAIL, API_PASSWORD are a platform super administrator; add API_TOTP_SECRET
#     if the API enforces two-step sign-in (it always does in staging and production).
node scripts/supabase-to-api/load.mjs ... --apply [--adopt <slug>=<tenant id>]... [--allow-remote]
```

`--apply` against anything but this machine needs `--allow-remote`. Use one `--state` folder per target API: a
ledger belongs to one API and the script refuses to reuse it for another.

Order inside a school: the school (platform endpoint), its profile fields, academic years and terms, staff,
classes, learners, class placements, guardians and their links, and **last** the archiving (an archived learner
can no longer be placed, linked or marked).

## Safe to stop and run again

- Every created record goes in `<state>/ledger.jsonl`, and every create carries an `Idempotency-Key`
  (`mig:<kind>:<source id>`). A second run changes nothing.
- A lost ledger is survivable for records the API can match by a natural key (years by label, terms by year and
  index, classes by name, learners by admission number): they are adopted, not duplicated.
- Staff and guardians have no natural key. If the API already holds some and the ledger has no record of making
  them, the run **stops** rather than copy them. Restore the ledger, or clear the school, and run again.
- A school that already exists in the API stops the run with the exact `--adopt` command to copy into it.

## What is carried, and what is not

| Supabase | In the API | Notes |
|---|---|---|
| `tenants`, `organizations` | school, organization, school profile | name, slug, county, country, level, type, MoE number, accent, time zone. Plan, status, seats, AI settings, payment details, role labels: not carried. |
| `terms` | academic year + terms | One year per Supabase `year`; terms need index 1 to 4. |
| `classes` | classes | All placed in the **current** year, because Supabase classes are not tied to a year. |
| `profiles` (not parents or students) | staff directory records | **No login.** Guard and receptionist become `staff` with that title. |
| `students` | learners + class placement | Needs gender (male or female). |
| `guardians` + parent `profiles` | guardians + links | One guardian per parent, linked to each of their learners. No login. |

Counted in the plan report as "not carried" because the API has nowhere to put them: learner address and map
location, birth certificate and UPI numbers, nationality, religion, previous school, photos, staff alternate
phone and leaving date, school settings. Not built yet: subjects and teaching assignments, finance, attendance,
marks (see below).

## Rules the script will not bend

- **A child's gender is never guessed.** The API requires male or female. A learner without one is *blocked*
  until the school supplies it, in an overrides file:
  `{ "learners": { "<admission_no>": { "gender": "female", "date_of_birth": "2011-03-02" } }, "schools": { "<slug>": { "admin_email": "head@school.example" } } }`
- A value the API would refuse (admission number or name starting with `= + - @`, a future date of birth, a
  phone or email in a shape it rejects, a duplicate admission number or class name) is either blocked or left
  out with a warning. The plan report lists each by source id and reason, never by name.
- The first school administrator comes from the school's active `school_admin` profile's email (or the
  override). The API returns that person's invitation token **once**; it is appended to
  `<state>/invitations.jsonl` (secret, never printed). There is no email provider yet, so someone has to deliver
  it. Delete the file afterwards.

## Passwords and logins

Supabase passwords cannot move: they are bcrypt, and the API verifies only Argon2id and scrypt. Nobody keeps a
password, and the API has no email or SMS delivery. Staff and guardian logins are therefore a separate step
(invitations whose tokens are handed over out of band), not part of this copy. Decide that with the schools.

## Before a real run

1. The API is deployed with a database, HMAC secret, and a platform super administrator (FIG-1870), and that
   administrator has set up two-step sign-in. The script only answers the challenge; the one-time enrolment is
   done by a person, who keeps the secret and recovery codes. A super admin cannot reset their own two-step.
2. A read-only database role on the hosted Supabase project, for `SOURCE_DATABASE_URL`.
3. Rehearse on a throwaway API and database first: run the plan, then `--apply`, then run it again (it must
   change nothing), then compare counts and per-class headcounts with Supabase.

## Not built, and why

- **Finance** cannot be copied with its history. The API stamps every payment with the time it is entered and
  makes payments immutable; invoices exist only through a term billing run; a payment cannot exceed the balance.
  History can be rebuilt as opening balances, not as a dated ledger. Needs a decision with Ancel and the schools.
- **Marks and exams**: scores can be copied (draft, then publish), but the API sets the mark and publish times
  and has no exam date.
- **Attendance** can be copied with its dates (the term, class and placement must exist first).
- Subjects and teaching assignments (the API needs subjects first), early sign-outs, health, transport, chat.

## Tests

`npx vitest run scripts/supabase-to-api`. The mapping, API client, sign-in and loader are covered, and each rule
above was mutation-checked.
