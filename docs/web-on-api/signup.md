# Organisation sign-up on the new API (`/signup`, and the requests tab on `platform/organizations`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md). The API half and its reasons are in
[`apps/api/docs/ORG-SIGNUP.md`](../../apps/api/docs/ORG-SIGNUP.md) (migration 124); read that first. Owner decisions: **D8** (the
platform approves; the public route is rate limited and checks the e-mail address) and **D2** (this API's console approves and
rejects; the part about console.figbloom.org is not built, finding signup-6).

## What the pages do

| Page | Address | What it does |
|---|---|---|
| Sign-up form | `/signup` | Asks for the organization's name, the signer's name and e-mail, and (under "More details") what kind of body it is, the county and a phone. **No password and no web address**: the API stores a request and e-mails a link. Every address gets the same "Check your email" screen. |
| Confirm the e-mail | `/signup/verify?token=...` | The link in that e-mail. It asks first and confirms when the person presses **Confirm my email** (mail scanners open links; the token works once). A bad, used, replaced or expired link says so in one sentence. |
| Requests tab | `/platform/organizations` (second tab) | Platform console. Lists requests (Needs review, Email not confirmed, Decided, All) with the details the reviewer needs, **Approve…**, **Reject…** (with an optional reason that stays on the platform) and, for an approved request whose administrator has not chosen a password, **Send a new password link…**. The "Pending review" stat of the page now counts requests waiting for review. |
| Sign-in | `/signin` | A "Registering an organization? Get started" link to `/signup` (the landing page's "Get Started" already pointed there; on the API build `/signup` used to fall through to the sign-in page). |

After approval the first administrator opens the e-mailed link (`/reset-password?token=...`, the existing page), chooses a password,
signs in and lands in the new organization's console. When the server has no e-mail provider the link is returned once to the
reviewer, who sees it in a dialog with a Copy button.

## Code

- `packages/shared/src/api/orgSignupApi.ts` (+ test): `apiRequestOrgSignup`, `apiConfirmOrgSignup` (public: no session, no school),
  `apiFetchPlatformOrgSignups`, `apiApprovePlatformOrgSignup`, `apiRejectPlatformOrgSignup`, `apiReissuePlatformOrgSetup`. Times from
  the server carry microseconds; the mapper cuts them to milliseconds so every browser can read them.
- `apps/web/src/api/ApiSignup.tsx` (the two public pages) and `ApiSignupRoutes.tsx` (registered in `ApiApp.tsx` by one line).
- `apps/web/src/screens/platform/ApiPlatformOrgSignups.tsx` (the requests panel) and a tab bar in `ApiPlatformOrganizations.tsx`.
- No capability flag: these files are API-only (the Supabase build has its own `Signup.tsx` and organizations page, unchanged). A
  server that has the route switched off answers 503 and the form says "Sign-up isn't available right now. Email hello@figbloom.org".

## Verified, and not

Verified: `tsc` (web, shared), eslint on every file changed, `openapi:check`, the shared unit tests, the API tests of
`test/org.signup.test.ts`, and one browser pass (20 checks, Edge) against a throwaway API with the sign-up switch on and a notifier
that keeps every message: the form and its inline errors, the same screen for a new address / a waiting request / an address with an
account, the replaced link failing, confirming only on the button, the requests tab and its count, the details, approving (address
made from the name, the administrator choosing a password from the e-mailed link and landing in the new organization's console, an
organization admin refused at the platform console), rejecting an unconfirmed request (nothing sent) and a confirmed one (a notice,
the reason kept), an address with an account refused with words, the link shown to the reviewer when e-mail is off (and a typed
address used), re-issuing a link, the rate-limit message, and no page or console errors.

Not verified: a real e-mail provider (Resend) and the real links in a real mailbox; the Supabase build (nothing there changed);
phone widths; the platform console with MFA enforced for the super admin (the throwaway API ran with it off); a real
console.figbloom.org.

## Findings

signup-web-1. **`formatShortDate` reads a date, not a time.** It builds `new Date(\`${value}T00:00:00\`)`, so a full timestamp such as
    `2026-11-26T10:05:00.000Z` gives "Invalid Date". The requests tab uses its own helper (date and time in the reviewer's zone).
    **Pre-existing and not touched here:** `ApiPlatformOrganizations.tsx` ("created ..." and "since ..."), `ApiPlatformTenants.tsx`
    (five places) pass timestamps to it, so those lines read "Invalid Date" on the API build. A one-line fix in `formatShortDate`
    (`dateOnly.slice(0, 10)`) would cure all of them; it changes a shared helper both builds use, so it is left for its own change.
signup-web-2. **The first administrator lands on the existing "Choose a new password" page**, with its reset wording and its "Ask for a
    new one" advice, which for this person means asking the platform (re-issue). A page that says "Welcome, choose your password" for
    approval links would be kinder; it needs a marker on the link (a query flag) and was not added to the shared reset page.
signup-web-3. **The sign-up form does not say whether an address has an account or a request**, by design (enumeration). The reviewer
    finds out at approval (409 with words). A person who typed the wrong address of someone else's simply never confirms, and the
    request expires after 24 hours.
signup-web-4. **The reviewer sees the typed kind, county and phone as given**, unverified. Nothing checks that a "government" body is
    one. Approval is the check.
signup-web-5. **No badge on the platform sidebar** for requests waiting for review: the nav counts (`fetchPlatformNavCounts`) are
    shared with the Supabase build and have no count for this. The tab and the stat on the Organizations page show it.
signup-web-6. **console.figbloom.org** (D2, "and seen in the console"): not built, see `apps/api/docs/ORG-SIGNUP.md` finding signup-6 for
    exactly what is needed from that console.
