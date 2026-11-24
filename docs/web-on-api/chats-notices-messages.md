# Chats, notices and messages

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.


`admin/chats`, `teacher/chats`, `teacher/notices` and `teacher/messages` run on an API build. The screens are the Supabase
app's own; the shared functions behind them (`chat.ts`, the notice functions in `teacherData.ts` and `otherStaff.ts`,
`subscribeAnnouncements` in `parentData.ts`) branch on `onApi()` into `api/chatApi.ts`, `api/noticesApi.ts`,
`api/inboxApi.ts` and `api/directoryApi.ts`. `staff/chats` and `staff/notices` use the same functions: when the staff shell
exists it needs only the two routes.

| Page | On the API build |
|---|---|
| `admin/chats` | "My chats" only: list, start a chat, read and send text. The "All school chats" and "Calls" tabs are hidden |
| `teacher/chats` | The same list and thread. A plain teacher cannot see names or start a chat (finding 29) |
| `teacher/notices` | The inbox, newest first, with the notice's text. No unread marks, attachments or signatures |
| `teacher/messages` | Opens. A teacher without the Communication area gets a message saying why instead of a composer (finding 33) |

## Polling instead of realtime

The API has no push channel, so `packages/shared/src/api/poll.ts` asks again every few seconds. The header of that file
is its documentation. In short: `startPolling`, `pollNewItems` (the shape of `subscribeChatMessages` and the other
`subscribe*` helpers that deliver rows) and `pollChanges` (the shape of `subscribeAnnouncements`); one request at a time;
paused while the tab is hidden and after 10 minutes with no input, so a tab left open does not keep the API's idle timer
alive; one catch-up request when the person comes back; a longer wait after failures. An open thread asks every 4.5 s, the
chat list every 10 s, the notices inbox every 30 s. The fleet, visitors and parent slices use the same file.

## What is hidden on this build, and why

`chatCapabilities()` and `noticesCapabilities()` in `packages/shared/src/capabilities.ts`; the shared function behind each
control throws `NotOnApiError`.

| Hidden | Missing in the API |
|---|---|
| Sending and opening files in a chat | chat messages are text only; files wait on storage (A5, FIG-1873) |
| Voice and video calls, and the school's call log | not in the contract (C13) |
| "All school chats" (the office reading every chat) and the line "The school's administrators can read this chat" | nobody can read a chat they are not in, the office included (finding 30) |
| Unread counts: the menu badge, a bold name, the count on a chat | the API does not say what a person has read (finding 29) |
| Unread dots and the menu badge on notices | the inbox has no read state (finding 32) |
| Notice attachments, "Waiting for your signature", the AI writing helper in Messages | storage (A5), signatures (C12), an edge function; the same as the Announcements page |
| A list of people to start a chat with, for a person who may not read the staff list | there is no contacts endpoint (finding 29) |

## How the model is mapped

- A chat has `peer_user_id` and `last_message_at`, nothing else. The other person's name comes from the staff list
  (`GET /staff`, which needs `resource.staff.read`: a school admin and the People area have it, a plain teacher does not),
  kept for a minute per school. Without it the chat shows "Someone at the school". Parents and learners cannot be named:
  guardian contacts carry no account id.
- The chat list's preview is the newest message of each of the 30 latest chats, one small request each.
- "Start a chat" offers staff who have an account (`userId` on the staff record), active, other than the person. Who may
  talk to whom is the server's `may_talk`: staff with staff, a parent with the school office. A refused pair is a 403 on
  the first message, shown as the server's own words.
- A thread is the newest 1,000 messages. A poll asks for the newest 50 and merges by id.
- The notices inbox is `GET /communications/announcements/inbox`: what reaches the person (whole school, their role, them by
  name, the classes they teach) and what they wrote. That is more than the Supabase list, which showed only whole-school
  notices and ones sent to the teacher by name. "From" is "You" for their own, a teacher's name when the staff list can be
  read, else "School office".
- "Sent by you" is the person's own published notices, read from the inbox (a teacher cannot read the composer's list, and
  drafts are not in the inbox). Opening a notice calls `POST .../read` once, for when the inbox says what is read.
- A class message is an in-app announcement with audience `{ kind: "class", class_id, recipients }`, created and published.
  `recipients` is stored but the server's reach rule ignores it. Parents and learners are not reached until their accounts
  are linked (FIG-1869): only the teachers of that class see it. The composer says so.
- A teacher who holds an admin area lands in the admin console on this build, which has no console switch yet. Their
  `teacher/chats`, `teacher/notices` and `teacher/messages` are reachable by address only, as `teacher/leave` is.

## Things found in the API while doing this (for the owner)

29. **The chat list is only ids.** `GET /chat/conversations` answers `peer_user_id` and `last_message_at`: no name, no role,
    no last message, no unread count. There is also no "people I may chat with" list, no unread count and no single-chat
    read. A plain teacher cannot read `/staff`, so every chat is "Someone at the school" and they cannot start one. Add to
    each conversation `peer { user_id, full_name, role }`, `last_message { body, sender_id, created_at }` and
    `unread_count` (from `conversation_members.last_read_at`, which exists and is never returned), plus
    `GET /chat/contacts` (the people `may_talk` allows, with a name and a role) and `GET /chat/unread-count`.
30. **No oversight read.** `listMessages` needs membership of the chat, so the office cannot read other people's chats, and
    there is no school-wide list. The Supabase app tells families and teachers "The school's administrators can read this
    chat", and the Communication area is described as reading the school's chats. That is a product and privacy decision
    first, an endpoint second.
31. **Chat messages come newest first with no `since`**, so a poll re-reads a page. A `since` (or `after`) cursor on
    `GET .../messages` and on the conversation list would make polling cheaper (B7).
32. **The announcements inbox has no read state and no author name.** Items have the composer's shape, with `author_id`
    only. `communications_announcement_reads` is written by `POST .../read` and never returned. Add `read_at` (null when
    unread) and the author's name and role to each inbox item. Class and year-group notices also reach no parent or learner
    until their accounts are linked (FIG-1869), and `recipients` in a class audience is ignored by
    `communications_audience_reaches`.
33. **A teacher cannot send a class message.** `POST /communications/announcements` and `.../publish` need
    `resource.announcement.write`, which only the school admin role and the Communication area hold. The check for a `class`
    audience does not look at who the sender is: anyone with the permission can post to any class. A rule that lets a teacher
    create and publish a `class` announcement for a class they teach (the reach function already knows who teaches what)
    would make the Messages page work for the people it is for. It widens who may write to families, so it is the owner's
    call.
34. **`/notifications` is not announcements.** It lists generic in-app notifications (transport, medication and so on; its
    items are an untyped `object` in the OpenAPI file), and publishing an announcement creates none. The Notices page does
    not use it. A bell or a notification centre would be a new screen the web app does not have.
