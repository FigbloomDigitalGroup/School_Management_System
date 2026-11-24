# Exam papers (`admin/papers`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `admin/papers` (`ExamPapers admin`). Capability flags: `examPapersCapabilities()` in `packages/shared/src/capabilities.ts`. The API side is `packages/shared/src/api/examPapersApi.ts`, registered in `apps/web/src/api/pages/exam-papers.pages.tsx`.

## What works

- **List online exam papers:** reads `GET /v1/tenants/{tenantId}/online-exam-papers` across pages and resolves class and subject names (`listClassesOrEmpty`, `listApiSubjects`), showing title, total marks (`max_score`), question count (when returned), class, subject, and created date.
- **Create an online exam paper:** `POST /v1/tenants/{tenantId}/online-exam-papers` with class, subject, title, total marks (`max_score`), and optional inline multiple-choice questions (`mcq` with `options`, `correct_answer`, and `points`). When questions are added, `max_score` is computed automatically from their marks; without inline questions, `Total marks` accepts `1` to `10000`.

## What is hidden and why

| Hidden on the API build | Missing in the API |
|---|---|
| Read-only PDF/typed papers (`mode === "read"`), reference sheets (`file_path`) | `online-exam-papers` stores online papers only (no typed body or file attachment fields) |
| Paper kind (`exam`/`assessment`), instructions, `opens_at`/`closes_at`, `duration_minutes` | `OnlineExamPaper` has `title`, `max_score`, `questions`, and `created_at` only |
| Linking to a term exam (`Counts towards`) | No `assessment_id` / `exam_id` field on `OnlineExamPaper` |
| Draft / publish / unpublish workflow | `POST /online-exam-papers` creates live papers immediately |
| Edit and delete actions | No `PATCH` or `DELETE /online-exam-papers/{paperId}` endpoints |
| Short/long written questions and model answers | `PostOnlineExamPapersRequest` accepts `kind: "mcq" \| "true_false"` with `correct_answer` only |
| **Scripts** modal (attempt list, marking written answers, releasing results, extensions/excusals, sending scores to Gradebook) | No `GET /online-exam-papers/{paperId}/attempts` or grading/release endpoints |
| Bloom AI question drafting & paper import buttons | `aiCapabilities().aiDrafting` is false (calls Supabase edge functions) |

## How the model is mapped

- `apiQuestionsFromDrafts` maps editor `choice` drafts to `{ id: "q1".., prompt, kind: "mcq", options, correct_answer, points }` where `correct_answer` is the selected option string (`options[correctOption]`), enforcing the API's 1,000-character prompt limit and 200-character option limit.
- `apiFetchSchoolClassOptions` and `apiFetchSchoolSubjectOptions` back the admin class and subject pickers (`fetchSchoolClassOptions`, `fetchSchoolSubjectOptions`).
- `apiFetchClassSizes` backs `fetchClassSizes`, filtering active memberships by active learners (`listActiveLearnerIds`).

## API findings (`papers-1` to `papers-3`)

- **papers-1:** `GET /v1/tenants/{tenantId}/online-exam-papers` does not return `questions` in its SQL `SELECT` (`apps/api/src/modules/academics/higherEd.ts`, `listOnlinePapers`), even though `OnlineExamPaper` in OpenAPI declares `questions` as an optional array. Listed papers therefore show `questionCount: 0` unless `listOnlinePapers` includes `questions`.
- **papers-2:** There is no `GET /online-exam-papers/{paperId}/attempts` endpoint, no `PATCH` or `DELETE` on `online-exam-papers`, and no `opens_at`/`closes_at`/`duration_minutes` or written-answer support, so the **Scripts** workflow and editing/deleting papers cannot run on the API yet.
- **papers-3:** `POST /online-exam-papers` has no link to a term `assessment_id`, so scores from online papers cannot be pushed into the Gradebook on the API.
