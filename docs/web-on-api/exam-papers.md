# Exam papers (`admin/papers`, `teacher/exams`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `admin/papers` (`ExamPapers admin`) and `teacher/exams` (`ExamPapers`). Capability flags: `examPapersCapabilities()` and `canManageExamPapers()` in `packages/shared/src/capabilities.ts`. The API side is `packages/shared/src/api/examPapersApi.ts`, registered in `apps/web/src/api/pages/exam-papers.pages.tsx`.

## What works

- **List online exam papers:** reads `GET /v1/tenants/{tenantId}/online-exam-papers` across pages and resolves class and subject names (`listClassesOrEmpty`, `listApiSubjects`), showing title, total marks (`max_score`), question count (when returned), class, subject, created date and status (**Draft** until published, then **Open now**; `published_at` comes from the API). In teacher view (`teacher/exams`), `fetchMyTeachingPairs` (via `GET /staff/me` and `GET /teaching-assignments`) filters papers to classes and subjects the teacher is assigned to teach.
- **Create an online exam paper:** `POST /v1/tenants/{tenantId}/online-exam-papers` with class, subject, title, total marks (`max_score`), and optional inline multiple-choice questions (`mcq` with `options`, `correct_answer`, and `points`). When questions are added, `max_score` is computed automatically from their marks; without inline questions, `Total marks` accepts `1` to `10000`. A new paper is a **draft**: learners read only papers where `published_at` is set (migration 110), so it is invisible to them until it is published.
- **Publish a paper (W0.1):** the **Publish** button in the list, and **Save and publish** in the editor (create, then publish), call `POST /v1/tenants/{tenantId}/online-exam-papers/{paperId}/publish` (`resource.academics.write`, the same right as creating). Publishing again is safe: the API keeps the first time. **Save draft** makes the paper and leaves it unpublished. Save and publish is refused in the editor when the paper has no questions (a learner's Exams page leaves out a paper with no questions, so publishing one would show them nothing).

## What is hidden and why

| Hidden on the API build | Missing in the API |
|---|---|
| Plain teachers without Academics area (`teacher/exams`) | `GET/POST /v1/tenants/{tenantId}/online-exam-papers` require `resource.academics.read` / `resource.academics.write` |
| Read-only PDF/typed papers (`mode === "read"`), reference sheets (`file_path`) | `online-exam-papers` stores online papers only (no typed body or file attachment fields) |
| Paper kind (`exam`/`assessment`), instructions, `opens_at`/`closes_at`, `duration_minutes` | `OnlineExamPaper` has `title`, `max_score`, `questions`, and `created_at` only |
| Linking to a term exam (`Counts towards`) | No `assessment_id` / `exam_id` field on `OnlineExamPaper` |
| **Unpublish** (taking a published paper back to a draft). Flag `unpublishPaper`, off by design | The API has no unpublish: a learner may already have started the paper (`publishOnlinePaper` in `higherEd.ts`; `apps/api/docs/STUDENT-ACCOUNTS.md`, "Online exams") |
| Edit and delete actions | No `PATCH` or `DELETE /online-exam-papers/{paperId}` endpoints |
| Short/long written questions and model answers | `PostOnlineExamPapersRequest` accepts `kind: "mcq" \| "true_false"` with `correct_answer` only |
| **Scripts** modal (attempt list, marking written answers, releasing results, extensions/excusals, sending scores to Gradebook) | No `GET /online-exam-papers/{paperId}/attempts` or grading/release endpoints |
| Bloom AI question drafting & paper import buttons | `aiCapabilities().aiDrafting` is false (calls Supabase edge functions) |

## How the model is mapped

- `publishedAt` is `published_at` from the list (null when the API sends null or nothing), never `created_at`. Until W0.1 it was `created_at`, so every paper looked published, and the publish route was never called (see "Bug fixed in W0.1"). The "Created" column still shows `created_at`.
- `setPaperPublished(id, true)` calls the publish route; `setPaperPublished(id, false)` throws `NotOnApiError` before any request. `savedPaperPublishProblem` says nothing on the API, because the list carries no questions (exam-papers-5).

- `apiQuestionsFromDrafts` maps editor `choice` drafts to `{ id: "q1".., prompt, kind: "mcq", options, correct_answer, points }` where `correct_answer` is the selected option string (`options[correctOption]`), enforcing the API's 1,000-character prompt limit and 200-character option limit.
- `apiFetchSchoolClassOptions` and `apiFetchSchoolSubjectOptions` back the admin class and subject pickers (`fetchSchoolClassOptions`, `fetchSchoolSubjectOptions`).
- `apiFetchClassSizes` backs `fetchClassSizes`, filtering active memberships by active learners (`listActiveLearnerIds`).

## Bug fixed in W0.1: papers made on the API build were invisible to learners

`examPapersApi.ts` set a paper's `publishedAt` to its creation time and nothing called `POST .../publish`. Since migration 110 a new paper is unpublished and learners read only published ones, so a paper made from the API-build web screen never reached them. **Reproduced** on a throwaway API before the fix: a paper made through `createOnlineExamPaper` had `published_at = null` on the API while the web row said it was published, and a learner signed in with a student login (`ST-0001`, made by the office) saw 0 papers; after a raw `POST .../publish` the learner saw it.

What changed:

- `draftWorkflow` is now **on** for the API build: the Status column (Draft / Open now) and the Publish button.
- New flag `unpublishPaper` stays **off** on the API build (no endpoint, by design). The Supabase build keeps it on.
- New "API only" flag `oneStepCreate`: the API editor makes a paper in one `POST` that carries its questions and offers **Save draft** and **Save and publish**; it replaced `draftWorkflow` as the switch between the API editor and the Supabase editor, which is unchanged. The editor says a paper cannot be changed or removed once created (no `PATCH` or `DELETE` yet).
- Papers made on the API build before this fix, or before migration 110, are unpublished (migration 110 left existing papers unpublished). They now show **Draft** with a Publish button instead of looking published.

## What was verified in W0.1, and what was not

- Unit tests (`packages/shared/src/api/examPapersApi.test.ts`): `publishedAt` mapping (null, set, field absent), Draft status, create does not publish, the publish request (no body, repeatable), a 403 and a 404 on publish, no request for unpublish, a create, list, publish, list cycle, `savedPaperPublishProblem` on both builds, and both builds' full capability objects.
- Browser pass against a throwaway API (22 checks): the blurb, the editor buttons, Save draft shows Draft and a Publish button and no Unpublish, the learner does not see the draft, Publish, the row stops being Draft, the learner sees it, Save and publish, the no-questions refusal creates nothing, and no Unpublish control anywhere on the page.
- Not verified: the Supabase build in a browser (its screen branches and constants are unchanged and covered by the unit tests, but no browser was pointed at it: its local database is off limits to this work); the phone app (it has no API build); a teacher without the Academics area (that page stays the "can't post here yet" message); a school with many papers (paging was not exercised against a real API beyond the unit test); the editor's message for a publish that fails after the paper was created (the API refusal is unit-tested; that message was not exercised).

## API findings (`papers-1` to `papers-4`, then `exam-papers-5` to `exam-papers-8`)

The first four use the older `papers-` prefix; the new ones continue the count under the area's name.

- **papers-1:** `GET /v1/tenants/{tenantId}/online-exam-papers` does not return `questions` in its SQL `SELECT` (`apps/api/src/modules/academics/higherEd.ts`, `listOnlinePapers`), even though `OnlineExamPaper` in OpenAPI declares `questions` as an optional array. Listed papers therefore show `questionCount: 0` unless `listOnlinePapers` includes `questions`.
- **papers-2:** There is no `GET /online-exam-papers/{paperId}/attempts` endpoint, no `PATCH` or `DELETE` on `online-exam-papers`, and no `opens_at`/`closes_at`/`duration_minutes` or written-answer support, so the **Scripts** workflow and editing/deleting papers cannot run on the API yet.
- **papers-3:** `POST /online-exam-papers` has no link to a term `assessment_id`, so scores from online papers cannot be pushed into the Gradebook on the API.
- **papers-4:** `GET/POST /v1/tenants/{tenantId}/online-exam-papers` check `resource.academics.read` / `resource.academics.write`, so regular teachers without the Academics admin area cannot open `teacher/exams` unless a teacher-scoped route or permission is added.
- **exam-papers-5:** because the list does not return `questions` (papers-1), the screen cannot tell a paper with no questions before it is published, so the list's **Publish** button cannot refuse one. A learner's Exams page leaves such a paper out, so it is harmless but pointless. The editor's **Save and publish** does refuse it, because it knows the questions it just made. Suggestion: return `question_count` on the paper list rows (the learner read already has it). Also, `OnlineExamPaper.published_at` is optional in the OpenAPI schema although the server always sends it (null or a time); making it required would let the web stop guarding for an absent field.
- **exam-papers-6:** there is no unpublish and, until W1.3, no `PATCH` or `DELETE`. A paper made by mistake cannot be corrected, removed or taken back once created, whether draft or published, so the editor warns about it. If the owner wants a way to withdraw a published paper, the API must first say what happens to attempts already started; W1.3 (edit and archive) is the natural place.
- **exam-papers-7:** migration 110 left existing papers unpublished, so any school that made papers on the API before it needs the office to press Publish on each. Nothing publishes them automatically, and there is no bulk publish.
- **exam-papers-8:** `POST .../publish` answers 404 for a paper that is not in the school and 403 without `resource.academics.write`. The screen shows the API's own message in a toast (and, after Save and publish, tells the user the paper was saved as a draft). It does not tell the two apart.
