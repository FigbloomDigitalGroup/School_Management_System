# Sign-in invitations (People page)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.


On the API a sign-in is made by an **invitation**, not by the school choosing a password. The People page now has:

- **Learner card, Guardians:** each guardian with an e-mail or phone has **Invite by e-mail** (or **by SMS** when there is no e-mail). An open
  invitation shows "Invited (r***@gmail.com), open until ...", with **Send again** (a new invitation replaces the open one) and **Cancel invitation**.
- **Invite guardians** (toolbar, selected learners): the same controls for every guardian of up to 25 selected learners, with a line saying families
  cannot read anything on the new system yet.
- **Staff card, Sign-in:** a staff record with no sign-in is invited by e-mail (a teacher, other staff or a driver; an administrator's sign-in is made
  by the platform). A record that has a sign-in can have a one-time **reset link** made (needs the password confirmed again).
- Every invitation or reset answers `delivery`. When the message was not sent (no e-mail provider, or it failed; a local API never sends) the
  single-use code or link comes back once and is shown for the school to hand over, with a Copy button. Staff links are the web's own
  `/accept-invite?token=` and `/reset-password?token=` addresses.

| Hidden or missing on the API build | Why |
|---|---|
| A list of open staff invitations (the staff card shows only the one sent in this visit, which can be cancelled) | no endpoint lists them (finding 35) |
| Joining the new sign-in to the staff record by itself | nothing tells the web which sign-in accepted: the record's `userId` can only be set with a user id the web cannot find (finding 36) |
| A page where a guardian accepts the code | the guardian accept endpoints exist (`/v1/guardian-invitations/preview` and `/accept`) but the web has no page for them, and families can read nothing yet (FIG-1869) |
| Guardian invitations by e-mail text | the server sends no e-mail for guardian invitations (they are "handed over as a code or QR by the school"), so a guardian invitation always shows the code |
| Making a reset link for yourself or for an administrator | the server refuses both |

## API findings (continued)

35. **No list of open staff invitations.** `POST /v1/tenants/{id}/invitations` and its `revoke` exist; nothing lists them, so a page cannot show who
    was invited and is still waiting. Guardian invitations have a list.
36. **Accepting a staff invitation does not link the staff record.** The invitation takes an e-mail, a role and a name, and accepting makes a user and a
    membership; the staff record keeps `userId: null`. `PATCH .../staff/{id}` can set `userId`, but nothing returns a user's id (no members list, no
    lookup by e-mail). Linking by e-mail inside `account_accept_invitation` (a staff record of the school with the same e-mail and no `userId`), or a
    `staff_id` on the invitation, would fix it. Until then an invited teacher has a sign-in but is not "their" staff record (their classes, leave).
37. **Guardian invitations carry no e-mail and no accept page.** `guardian_invitation` messages are never sent (the e-mail notifier returns
    `not_configured` for them), so the school hands over the code, and the web has no page that takes it.
