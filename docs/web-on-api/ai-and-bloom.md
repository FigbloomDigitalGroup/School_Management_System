# AI and Bloom (admin/assistant, admin/study-helper, admin/bloom, teacher/bloom)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Four pages: `admin/assistant` (School assistant), `admin/study-helper` (Bloom study helper), and `admin/bloom` / `teacher/bloom`
(Bloom chat, also opened from the floating **Ask Bloom** button). The API side is `packages/shared/src/api/aiApi.ts`, wired into
`ai.ts`, `aiChat.ts`, `aiHelper.ts`, `guide.ts` and `edge.ts`, with `aiCapabilities()` in `capabilities.ts`. The contract is
`bloom-school/1`: chat only, one prompt of at most 4,000 characters, no tools, no web search, no files, no saved chats.

The pages are registered in `apps/web/src/api/pages/ai-and-bloom.pages.tsx`. The Guide button and the Ask Bloom button are part of
the shell, so they are in `apps/web/src/api/ApiConsole.tsx` (`AdminPage` and `TeacherPage`).

## What works on the API build

- **School assistant** (`admin/assistant`, full admins only): the setup checklist reads real counts across academic terms, classes,
  subjects, teachers, teaching assignments, active learners, guardians, fee items, invoices and exams. The chat sends questions to
  `POST /v1/tenants/{tenantId}/ai/query` (`scope: "school"`) and answers in plain text, with no page links and no setup plans. The
  "School details and crest" and "How parents pay" steps are left off the list, because the API stores no crest or payment details
  and the checklist could not say whether they are done.
- **Guide** (the sidebar button, any admin console): the same chat, shown only where `/ai/status` says Bloom is on for the school
  (it stays while the status is being read or cannot be read, and then says why it cannot answer).
- **Bloom study helper** (`admin/study-helper`, full admins and the Fees area): reads the access mode from
  `GET /finance/ai-helper/settings`, readiness from `GET /ai/status`, and (when access is "only where a parent turns it on") the
  current term's opt-in choices from `GET /finance/ai-helper/optins`, with learner names, admission numbers and classes where the
  caller may read them. When access is "every learner" there is nothing to list, so the page shows no table.
- **Bloom chat** (`admin/bloom` for full admins, `teacher/bloom` for teachers): checks `GET /ai/status` and sends each question to
  `POST /ai/query`. The message box stops at 4,000 characters; the whole chat is packed into one prompt of at most 4,000 characters
  (newest turns kept, latest question always kept) and the page says so. Copy, regenerate and export (PDF, Word, Excel, CSV) work
  in the visit. A teacher gets the same chat (the API gives teachers the `public` and `school` scopes).

## What the person sees when Bloom cannot answer

| State | What the page shows |
|---|---|
| School has no study helper settings row (`enabled_for_school: false`) | Chat: "Bloom is not turned on for this school yet. The new system has no switch for it yet." The box is disabled. Study helper and School assistant say the same in their own words. No Ask Bloom button; no Guide button once the status has loaded. |
| On, but `provider_configured: false` | A note above the chat: "Bloom is turned on for this school, but no AI service is connected to this server yet. Questions will not be answered." A question gets "Bloom AI is not available on this server yet." (503, no Retry-After). |
| On, circuit open | A note: "Bloom is not answering right now. Try again in a moment." A question gets the same with the seconds from Retry-After. |
| Rate limit (429) | "Bloom is getting a lot of questions. Try again in N seconds." |
| Another 403 (scope not allowed) | The API's own sentence. |
| Network down, timeout | The usual API sentences ("Can't reach the server..."). |

## What is hidden on the API build and why

`aiCapabilities()` hides these, and the shared function behind each throws `NotOnApiError`:

| Hidden on the API build | Missing in the API |
|---|---|
| Saved Bloom chat history (sidebar list, open, rename, delete chats). A "New chat" button starts a fresh in-page chat | no `ai_chats` / `ai_chat_messages` endpoints on `apps/api`; chats stay in memory for the visit |
| Bloom web search toggle and Google Drive file attachments | `bloom-school/1` is text chat only (4,000 characters), with no web search or file fields |
| Lesson plans, paper import, report card comments, question, homework and message drafting and translation (`aiDrafting`) | not in `bloom-school/1` (`capability: "chat"`, `tools: []`, C13) |
| School assistant setup plans ("Create N") and links to pages | `bloom-school/1` has `tools: []`, so no structured actions or links come back |
| Study helper "Turned on by", monthly usage columns (questions, tokens, last used) | `/finance/ai-helper/optins` returns `changed_by` ids only, and per-learner AI usage is not tracked |
| School AI on/off and web-search switches (`saveAiSettings`), and the "turn it on in School settings" wording | no endpoint to turn Bloom on or off (finding `ai-1`) |
| Study helper chat for learners and the learner status call (`askTutor`, `fetchAiHelperStatus`) | learners and parents have no sign-in on the API build yet, and `/ai/query` is the only AI route |

`invokeEdge` now throws `NotOnApiError` on an API build, so a Supabase edge function is never called by mistake.

## Things found in the API while doing this (numbered `ai-1` to `ai-4` so that no other area shares a number)

ai-1. **Bloom is "on" when a school has a row in `finance_ai_helper_settings`.** `GET /ai/status` sets `enabled_for_school: true`
    only then (the row is made by `PUT /finance/ai-helper/settings`, which needs the finance administer permission). There is no
    switch to turn Bloom on or off, and no way to remove the row, so the web app cannot offer the "turn it on in School settings"
    control. Suggest: an explicit `ai_enabled` flag with its own `PUT`.
ai-2. **`POST /ai/query` answers 503 outside the error envelope.** When the provider is not configured or unavailable it sends
    `{ status, scope, reason }`, not `{ error: { code, message } }`, so `apiClient` only sees "The server answered 503." The web
    tells the two apart by the `Retry-After` header (sent only for `unavailable`). Suggest: use the standard envelope with a
    `reason` detail.
ai-3. **No Bloom chat persistence, no tools.** There are no endpoints to store or list Bloom chats, and `bloom-school/1` is one prompt
    (4,000 characters, `tools: []`). Multi-turn context is packed into the prompt by the web, and lesson plans, paper import and
    assistant setup plans stay hidden (C13).
ai-4. **Study helper opt-ins carry no names and no usage.** `GET /finance/ai-helper/optins` has `changed_by` ids only (no guardian
    name) and no monthly question or token counts, so those columns are hidden. The school profile also has no payment details or
    crest, so the School assistant leaves those two checklist steps off.
