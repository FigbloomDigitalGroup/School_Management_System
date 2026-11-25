# Account and access (admin/account, teacher/account, admin/access)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.


Opened from the menu on an API build: **My account** (the avatar menu, and the sidebar's "My account" / "Account" entry) for school
admins and teachers, and **Access & roles** for full admins. The shared account code is reused by `staff/account`, `driver/profile` and `parent/settings` (`AccountSections`, `apps/web/src/components/account/`).

## My account

- **Your details**: name, email, sign-in ID, role and school, read from `GET /v1/auth/me`. Read-only (see below).
- **Password**: current password, new password twice, with the server's rule (10 or more characters, letters and numbers). The server
  ends the person's other sessions and keeps this one. The sidebar's "Change password" does the same call.
- **Two-step verification**: its state from `GET /v1/auth/mfa/status`. A person who has it can make new recovery codes (a fresh code
  from the app is needed) and, where their role does not require it, turn it off. Setting it up still happens at sign-in, when the server
  asks for it.
- **How we reach you**: the notification switches of `GET`/`PATCH /v1/me/notification-preferences`, saved when flipped. A staff
  member has "General school notices" and "Chat messages"; a family has all five.
- Every call that needs the password again (`reauth_required`: new recovery codes, turning two-step off, giving access) opens the app's
  own "Confirm your password" prompt (`ApiSessionGuard`) and is retried once.

| Hidden on the API build | Why |
|---|---|
| Changing your own name, phone or second phone | no endpoint: `PATCH /v1/auth/me` does not exist, and `/v1/auth/me` carries no phone |
| Your photo | needs file storage (A5, FIG-1873), and the API holds no photo |
| "Call someone" (teacher) | calls are not on the API (C13) |
| Setting up two-step from the account page | the server only asks for the code from people it requires it of, so a set-up on this page would never be used (finding 18) |
| Turning two-step off, for a person whose role needs it | the server would only ask them to set it up again at the next sign-in |

## Access & roles

Full admins give **admin areas** to a teacher or other staff member, one person at a time (`PUT /v1/rbac/staff-areas`, read back with
`GET /v1/rbac/staff-areas`, the new endpoint of the API PR #362), with the same quick picks and area ticks as the Supabase build. The same
card gives or takes away **access to parents' records** (`/v1/rbac/guardian-access`, read and change apart). **Organization
administrators** who were given access to the school are listed, with a way to take it all back (`/v1/rbac/org-delegations`).

| Hidden on the API build | Why |
|---|---|
| The school's own named roles ("Exams officer": make, edit, delete, give to people) | the API has no write path for school roles (finding 20) |
| Giving an organization administrator access | the list carries user ids only and nothing looks an administrator up; it starts from the organization console, which is not on the API build (finding 21) |
| Admin areas for a person with no sign-in, a driver, a full admin, or yourself | areas belong to a sign-in; the server only lets teachers and staff hold them, and refuses your own |

## API findings (for the API owner)

17. **No way to change your own name, phone or photo.** The `users` table has a `full_name` and a `phone`, but there is no
    `PATCH /v1/auth/me`, and `GET /v1/auth/me` returns no phone. The staff directory holds its own name and phone for the same person, so
    one of the two would have to win.
18. **Two-step is only asked of the people it is required of.** `auth_mfa_state` makes `required` true for admins, org admins, super
    admins, anyone with the Fees area (and `MFA_REQUIRED_ROLES`). A teacher who sets it up anyway is never asked for the code at
    sign-in, so it protects nothing. The account page therefore offers no set-up to people who are not required.
19. **Nothing read another person's admin areas** (`GET /v1/rbac/permissions` is the caller's own), so `PUT /v1/rbac/staff-areas`, which
    replaces, could only be used blind. `GET /v1/rbac/staff-areas` is added in the API PR #362: one row per person with areas of their
    own, keyset-paged, for holders of `rbac.staff_areas.manage`.
20. **School roles have tables and a place in `authorize.ts` but no endpoints** (`school_roles`, `school_role_assignments`), and the API's
    own test says they have no write path. The Access screen shows none.
21. **Delegations name nobody.** `GET /v1/rbac/org-delegations` gives `delegateUserId` only, and no endpoint lists an organization's
    administrators, so a school cannot choose one to give access to.
22. **The password rule is not in the contract.** `passwordPolicy.ts` wants 10 or more characters with letters and numbers; the OpenAPI
    file says nothing, and the web's sidebar dialog said 8 (fixed here).
