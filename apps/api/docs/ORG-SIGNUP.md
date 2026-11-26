# Organisation self-service sign-up on the API (slice S6a, migration 124)

Written 2026-11-26. The owner's decisions: **D8** (the platform approves; the public route is rate limited and checks the
e-mail address) and **D2** (this API's console owns approve and reject). Code: `src/http/routes/signupOrganizations.ts`
(public), `src/http/routes/platformOrgSignups.ts` (platform), `src/modules/account/orgSignup.ts`, `migrations/124_org_signup.sql`.
Tests: `test/org.signup.test.ts` (refusals first). Web half: `docs/web-on-api/signup.md`.

## What it does, in one paragraph

A stranger asks for an organisation. The API stores a **request** and e-mails a link to the address given. Following the link
proves the mailbox. A super administrator then approves or rejects the request in the platform console. Only on approval does
anything exist in the identity plane: the organisation (`active`), the first administrator's account (`invited`, no usable
password) with an `org_admin` membership, and a password-setup link e-mailed to the confirmed address. The administrator chooses
a password from that link and signs in. **The public route can never create an account, an organisation or a school.**

```
POST /v1/signup/organizations          (public)  -> stores a request, e-mails a confirmation link   202 always alike
POST /v1/signup/organizations/verify   (public)  -> the link is followed                            200 once, else 400
GET  /v1/platform/org-signups                    -> the requests (personal data, audited read)
POST /v1/platform/org-signups/{id}/approve       -> organisation + invited admin + setup link
POST /v1/platform/org-signups/{id}/reject        -> rejected (a notice only to a confirmed mailbox)
POST /v1/platform/org-signups/{id}/reissue-setup -> a new setup link for an approved, not-yet-set-up administrator
```

States of a request: `pending_email` (link sent) -> `pending_review` (address confirmed) -> `approved` | `rejected`; a link that
lapses (24 hours) makes it `expired` (read as expired even before anything marks it). One open request per address.

## Why it is shaped like this

| Choice | Reason |
|---|---|
| A request table, not an organisation in `pending` | `organizations` and `users` are identity tables. A public route that wrote them could squat a slug or an address and block a real invitation later (`account_accept_invitation` asks an existing account to sign in). Nothing is written there until a human approves. |
| **No password at sign-up** | A person who typed someone else's address could pre-set that mailbox's password, and the real owner confirming the link would hand over the account. The administrator sets the password from a link only the confirmed mailbox receives. |
| The setup link is a `password_reset` token | `account_complete_password_reset` already activates an `invited` account, revokes sessions and stores an Argon2id hash. No new accept path. The account is made as `scripts/bootstrap-admin.mjs` makes the first platform administrator (credential `'!'`, nothing verifies against it). |
| The route never reads `users` | A new address, a waiting request and an address that has an account get the same 202. The "already has an account" case is found only at approval, by a super administrator. |
| The organisation's address is made at approval | The signer used to type a "web address" and was told at once if it was taken, which let anyone test which addresses exist. Now the platform sets it (from the name, or typed by the reviewer). The public school lookup (#414) was **not** reused: it answers for schools, and organisations have their own slugs. |
| Closed unless switched on | `ORG_SIGNUP_ENABLED` is off by default, as `HR_LEAVE_ENABLED` is. It is also closed (503) while e-mail is not configured, as the Supabase function was. |

## Database (migration 124)

- Permission `platform.org_signups.manage` (`super_admin` only), checked with no school.
- Table `organization_signups`: **owner-only**, forced row-level security whose only policy is for the owner, no privilege for
  `figbloom_app` or `figbloom_worker` (`RLS-CATALOGUE.md`). It holds a name, an address, a phone and the reviewer's reason, so it
  is reachable only through the functions below. The confirmation token is 32 random bytes; only its SHA-256 is stored and it is
  cleared once used, replaced or when the request is decided. A partial unique index allows one open request per address.
- `org_signup_submit(...)` and `org_signup_verify(token_hash)`: public, no acting user. `submit` takes one global advisory lock, so
  the daily cap is exact. It checks the cap **before** looking at the address, so a capped day gives every caller the same answer.
- `platform_org_signups_list`, `platform_org_signup_approve`, `platform_org_signup_reject`, `platform_org_signup_reissue`: each
  re-checks that `app.user_id` is a super administrator (`42501` otherwise). Approving takes the row lock, refuses a request that
  is not `pending_review` (`55000` -> 409), refuses an address that already has an account (`23505` -> 409), and creates the
  organisation, the user, the membership, the token and the audit row in **one transaction**.
- Audit events (`security_audit_events`, all hidden from schools): `org_signup.submitted` (id, kind), `.verification_resent`,
  `.verified`, `platform.org_signup.approved` (ids), `.rejected` (id, whether confirmed, whether a reason was given), `.setup_reissued`
  (ids), `.listed` (a count). **Never** a name, an address, a phone number or the reason.

## Abuse controls (public route)

| Control | Value |
|---|---|
| Body | strict JSON, at most 4 KiB (413 above), control characters refused, no unknown fields (a `password` is a 400) |
| Per person | 5 at once, then 5 an hour (`org_signup:ip:<address>`; an IPv6 caller counts per /64). The Supabase function allowed 5 an hour |
| Per address | 3 at once, then 1 an hour (`org_signup:email:<sha256>`; the bucket holds a hash, never the address) |
| Per day, everyone | `ORG_SIGNUP_DAILY_CAP` new requests (default 50, the Supabase number). Past it, 503 to every caller, resends included |
| Order | body check, then the switch and e-mail check, then the two buckets, then the database. A bad body costs no token |
| Confirmation | its own bucket (`org_signup_verify:ip`, the login numbers); every failure is the same 400 |
| Tokens | never returned, never logged (the access log carries no bodies), never audited, only their hash stored |
| Enumeration | one 202 for new, waiting, confirmed and "has an account"; the only other answers are ones everyone gets (400, 429, 503) |
| E-mail | the three messages carry no text the person typed. A rejection notice goes only to a mailbox that was confirmed (an unconfirmed address may be someone else's) |

## Differences from the Supabase function (`signup-organization`)

1. The organisation is not live at once: a super administrator approves it (D8). Supabase had paused its own approval step.
2. No password is collected at sign-up (see above); the first administrator sets one after approval.
3. No "web address" field and no "address taken" answer at sign-up; the platform sets the address (finding signup-1).
4. Supabase told an existing account's owner that someone had tried to register their address. The API sends nothing: that needs
   an account lookup on a public route (an enumeration oracle). The reviewer sees "already has an account" instead.
5. County and phone are kept on the request for the reviewer; the API's `organizations` has no such columns.

## Findings (`signup-N`)

signup-1. **Organisation addresses are chosen by the platform.** Derived from the name (lower case, a-z, 0-9 and hyphens, at most
    34 characters, a number added when taken, the platform's own words such as `platform` or `admin` get `-org`), or typed by the
    reviewer. A name with nothing usable in it (for example only symbols) becomes `org-<8 hex>`. The web shows the result.
signup-2. **An address that already has an account cannot be approved.** A person with a school login who now wants an organisation
    must use another address, or the platform must add the org admin by hand, and the API has **no path** to add an org admin
    to an existing account (`ORG-CONSOLE.md`, open decision 1: who may add an org admin). Owner decision.
signup-3. **No bot challenge.** There is no CAPTCHA. What stands in the way: a link only a real mailbox can follow, a human review
    before anything is created, the limits above and the daily cap. A scripted attacker with many mailboxes can fill the review
    queue up to the cap each day; each request still needs a reviewer's approval to become anything.
signup-4. **The daily cap is global.** One attacker can use up the day's cap and shut real organisations out until the oldest
    request is a day old (sign-up only; nothing else is affected). There is no alert on it (the codebase has no pattern for
    security alerts; `lookup-4`). The owner can lower or raise it (`ORG_SIGNUP_DAILY_CAP`).
signup-5. **Retention is not decided.** Expired and rejected requests keep a name, an address and a phone number, and nothing
    deletes them. Proposal for the owner: delete expired and rejected requests after 90 days. Not built (the audit retention
    question, `PLATFORM-CONSOLE.md` Q5, is the same kind of decision).
signup-6. **Nothing reaches console.figbloom.org.** D2 asked for these organisations to be seen there too. On Supabase the
    organisation is registered with that console by `platform-sync` and its decisions come back signed to `platform-decisions`.
    The API has neither. What this needs from that console: (a) how the API should tell it about an organisation (an endpoint, its
    authentication, the fields: id, name, kind, status, created time); (b) whether decisions will **also** be taken there, and then
    which one wins when the two disagree (`PLATFORM-CONSOLE.md` risk R2), with the signature scheme `platform-decisions` uses;
    (c) whether it should list the API's schools too. Until it is agreed, the API console is the only place a request is decided,
    and an organisation approved here is not visible there. No contract was guessed.
signup-7. **A lost or lapsed setup link needs a reviewer.** The link lasts 7 days. `reissue-setup` sends a new one while the
    administrator has not chosen a password. After that the administrator uses the normal "forgot password" (the account is then
    active). A request approved while e-mail is not configured returns the link once to the reviewer, who must pass it on.
signup-8. **Switching it on.** Set `ORG_SIGNUP_ENABLED=true` on the API after e-mail works (`RESEND_API_KEY`, `ACCOUNT_EMAIL_FROM`,
    `ACCOUNT_LINK_BASE_URL`, which the confirmation and approval links use: `/signup/verify` and `/reset-password`). The owner's call.
signup-9. **Not built:** editing a request, deleting one, a second reviewer or a reason shown to the person, rate limits keyed by
    the browser, an audit view of requests for a school (they belong to no school).
