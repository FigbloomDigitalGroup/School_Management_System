# Other staff console (role `staff`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

## Staff shell

A person whose role is `staff` (the librarian, the nurse, the receptionist, the cook) used to get the plain overview page on an API
build. They now open the **staff console** (`StaffPage` and `staffRoutes` in `apps/web/src/api/ApiConsole.tsx`): the same menu as the
Supabase app (`NAV.staff`), cut down to what runs on the API. They land on `/s/<slug>/staff`. Someone who also holds admin areas lands
there too and gets the same **Staff | Admin** switch as on Supabase; the Admin side shows only the pages of their areas, as it
does for any staff member (the existing page gate).

The screens are the Supabase app's own. The one new screen is the home (`ApiStaffHome.tsx`): on Supabase the staff home is only a
redirect to the visitor log, the sick bay or Notices, and not all of those run on the API yet.

| Page | On the API build |
|---|---|
| `staff` (home) | Who is signed in, the **job title and phone from the person's own staff record** (`GET /v1/tenants/{tenantId}/staff/me`, `api/otherStaffApi.ts`: the session carries no title on the API, finding staff-2), the pages in their menu, the school, the connection check. The title also shows under the name in the menu. A sign-in with no staff record says so ("None on file"), and nothing is made up |
| `staff/notices` | The inbox (`fetchStaffNotices` → `api/noticesApi.ts`, from the chats and notices slice). No unread marks, attachments or signatures |
| `staff/chats` | The same list and thread as `teacher/chats` (`MyChats role="staff"`). A staff member cannot read the staff list, so chats show "Someone at the school" and they cannot start one (finding 29) |
| `staff/leave` | The school's own leave form (the teacher's `Leave` screen): request, history, withdraw. Supabase gave other staff a Leave page only where the school's leave is Figbloom HR's; on the API there is no HR handoff, so the school's form is the one page for everyone |
| `staff/account` | **My account**: details (read-only), password, two-step status, and "How we reach you" (a staff member has "General school notices" and "Chat messages"). Same sections as `admin/account` and `teacher/account` (`AccountSections`). The avatar menu's "My account" now works for staff |
| `staff/items` | **Only for staff who hold the Inventory area** (see below) |

## What is hidden on the API build, and why

`hiddenNav` in `StaffPage` hides these entries of the staff menu, and their addresses send the person back to the staff home.

| Hidden | Why | Turns on when |
|---|---|---|
| `staff/visitors` | the visitors module (`visitors.ts`) has no API side yet (`gate-visits`) | the visitors slice merges: add `staff/visitors` to `staff` in `apps/web/src/api/pages/staff-shell.pages.tsx` (for people holding the Visitors area: give it a `when`; `StaffVisitors` already checks it) |
| `staff/items` for a staff member **without** the Inventory area | `GET /inventory/issues` needs `resource.inventory.read`, which only the Inventory area gives (finding 13); the plain staff role is refused (403). The page shows for holders of the area (`staffMayReadItems`) | the API lets a person read their own issued items (finding staff-1) |
| `staff/loans` | no loans on the API: there is no HR product (C13) | not planned |
| `staff/my-hr` | no HR product on the API (C13) | not planned |

## What a plain staff account can and cannot do

Checked on a real API as a staff account with no admin areas, and as one holding the Inventory and Leave areas:

- **Can:** read their own staff record (`/staff/me`); request, see and withdraw their own leave (`/leave-requests` shows only their
  own to someone without the Leave area; overlapping dates are a 409, "Leave dates overlap an existing request"); read their notices
  inbox; use chats; open the account page (details, password form, notification switches).
- **Cannot** (all 403): read the staff list, learners, classes or academic terms; read the inventory register or issues (an Inventory
  area holder can: that is why My items is theirs, and they can open the admin Inventory and Leave pages). They have no admin console.
- **Cannot change their own name, phone or photo** (not on the API, see the account section), and cannot set up two-step: the server
  does not ask staff for it.
- A staff sign-in that is **not linked to a staff record** (finding 36: an invited person is not joined to their record) opens the
  home and account pages, with no job title and no phone, and "None on file" on the home page.

## Where the code is

- `apps/web/src/api/pages/staff-shell.pages.tsx`: the staff pages (`staff/notices`, `staff/chats`, `staff/leave`, `staff/account`,
  `staff/items`). `pages/types.ts` has a `staff` list for them (`StaffPageDef`, with an optional `when` on the person's admin areas),
  and `pages/index.ts` builds `API_STAFF_PAGES` and `staffPagesFor(adminAreas)` from it.
- `apps/web/src/api/ApiConsole.tsx`: the shell's part: `StaffPage` (menu, job title, the Staff | Admin switch) and `staffRoutes`.
  `apps/web/src/api/ApiStaffHome.tsx`: the staff home.
- `packages/shared/src/api/otherStaffApi.ts`: the person's own staff record (`GET /staff/me`) and `staffMayReadItems`.

## API findings: staff (numbered `staff-1` and `staff-2` so that no other slice shares a number)

staff-1. **Nobody but an inventory manager can see what they hold.** `GET /inventory/issues` needs `resource.inventory.read` (the Inventory
    area) and lists every open issue in the school, so a staff member or teacher cannot read the items issued to them (finding 13 for
    teachers). The web reads the whole list and keeps the rows held by the signed-in person, so it works only for people who may read
    all of it. A `GET /me/inventory-issues` (the caller's own, no permission) would let `staff/items` and `teacher/items` open for everyone.

staff-2. **The session says nothing about a staff member's job title or staff id.** `GET /v1/auth/me` memberships carry a role and a
    sign-in ID only, so the menu and the staff home make a second call, `GET /staff/me`, on each page load of the console. Adding
    `staff_id` and `staff_title` to the membership would remove the call.
