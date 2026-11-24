# Report cards and competency ratings

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Two pages: `admin/report-cards` and `teacher/report-cards` (one screen, `screens/admin/ReportCards.tsx`).

## Report cards: what the API cannot do yet

`reportCardsCapabilities()` in `packages/shared/src/capabilities.ts` hides controls the API does not back yet (`admin/report-cards` and `teacher/report-cards`), and the shared functions behind them throw `NotOnApiError`:

| Hidden or different on the API build | Missing or different in the API |
|---|---|
| Choosing a subset of exams, and toggling position, attendance, fees, activities, or next-term date | `POST /v1/tenants/{tenantId}/report-cards` takes `{ term_id, class_id, grading_scheme_id? }` and always aggregates every published assessment, published/closed CBE assessment, and competency rating for that class and term |
| Draft state, "Send to families", and "Withdraw all" | `POST /report-cards` publishes immediately; there is no draft or withdraw endpoint |
| Per-learner class teacher and principal comments (and "Suggest missing comments") | `report_card_publications` stores a class-level `figures` snapshot with no per-learner comment fields |
| Signing report cards and printing signatures on PDFs | document signatures wait on C12 (`FIG-1880`) |
| "Draft comments with Bloom" (AI helper) | calls a Supabase edge function |
| Clearing a competency rating back to unrated | `POST /v1/tenants/{tenantId}/competency-ratings` only sets `EE \| ME \| AE \| BE`; there is no `DELETE` endpoint |

How the model is mapped (`packages/shared/src/api/reportCardsApi.ts`):

- `fetchClassReportCards` reads `GET /v1/tenants/{tenantId}/report-cards?termId=&classId=` (ordered newest first), takes the latest snapshot, and hydrates one `StoredReportCard` per learner from its `figures` (plus assessment marks, CBE results, and competency ratings) so the table and client-side PDF downloads (`Results sheet (PDF)`, `All report cards (PDF)`, and per-learner `PDF`) work.
- `saveCompetencyRating` tracks `row_version` per rating so updates send the optimistic concurrency version the API requires.
- **Plain teacher (OD-2) scope:** a plain teacher can read `/classes`, `/report-cards`, `/assessments`, `/assessments/{id}/marks`, and `/competency-ratings` for classes they teach, but gets 403 on `/academic-terms`, `/academic-years`, `/learners`, `/subjects`, and `POST /competency-ratings`. `fetchReportCardSetup` discovers terms from existing published report cards when `/academic-terms` returns 403, `fetchClassReportCards` degrades gracefully without learner names if `/learners` returns 403, and `CompetencyRatings` renders read-only when the caller lacks `resource.academics.write`.

## Where the code is

- `packages/shared/src/api/reportCardsApi.ts`: the API side of `reportCards.ts` and `competencies.ts` (`admin/report-cards` and `teacher/report-cards`).

## API findings: report cards and competency ratings (numbered 45 and 46 so that no other slice shares a number)

45. **Report cards are class-level published snapshots only.** `POST /v1/tenants/{tenantId}/report-cards` publishes immediately
    with no draft/withdraw workflow, no per-learner teacher/principal comments, and no learner names in `figures`. For a plain
    teacher (OD-2), `GET /report-cards` works for taught classes, but `GET /academic-terms` and `GET /learners` return 403,
    so a plain teacher cannot pick terms that have no published report cards yet and sees fallback learner labels instead of
    full names.
46. **Competency ratings cannot be cleared and require `resource.academics.write`.** There is no `DELETE` endpoint for
    `/v1/tenants/{tenantId}/competency-ratings`, and `POST` requires `resource.academics.write`, so a plain class teacher
    can view ratings for their taught classes (`GET` is OD-2 scoped) but cannot save ratings on the API yet.
