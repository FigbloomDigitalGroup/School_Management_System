# Learning materials (`admin/materials`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `admin/materials` (`LearningMaterials admin`). Capability flags: `materialsCapabilities()` in `packages/shared/src/capabilities.ts`. The API side is `packages/shared/src/api/materialsApi.ts`, registered in `apps/web/src/api/pages/materials.pages.tsx`.

## What works

- **List learning materials:** reads `GET /v1/tenants/{tenantId}/learning-materials` across pages and resolves class and subject names (`listClassesOrEmpty`, `listApiSubjects`), showing title, description preview, class, subject, and added date.
- **View material details:** opens the modal showing the material's title, class/subject eyebrow, and full description text.
- **Add learning material metadata:** `POST /v1/tenants/{tenantId}/learning-materials` with class, subject, title, and optional description.

## What is hidden and why

| Hidden on the API build | Missing in the API |
|---|---|
| File uploads and external links (`Upload a file`, `Paste a link`, `MediaPlayer`) | `POST /learning-materials` registers metadata only (`storage_status: "metadata_only"` — no file storage or URL field) |
| Draft / publish / unpublish workflow | `POST /learning-materials` creates live entries immediately |
| Edit and delete actions | No `PATCH` or `DELETE /learning-materials/{materialId}` endpoints |

## How the model is mapped

- `apiFetchMaterials` maps `LearningMaterial` (`storage_status: "metadata_only"`) to `MaterialRow` with `kind: "document"`, `filePath: null`, `url: null`, `publishedAt: m.created_at`, and falls back to `"All classes"` when `class_id` is null.
- `LearningMaterials` only mounts `<MediaPlayer>` when `filePath || url` is present so metadata-only entries render cleanly without an infinite loading skeleton.

## API findings (`materials-1`, `materials-2`)

- **materials-1:** `LearningMaterial` is `storage_status: "metadata_only"` with no `storage_object_id` or `url` field yet, so teachers/admins can share titled notes/descriptions only, not downloadable files or video links.
- **materials-2:** `GET /learning-materials` and `POST /learning-materials` require `resource.academics.read` and `resource.academics.write` (which regular teachers do not hold), and there are no `PATCH` or `DELETE` endpoints on `/learning-materials`.
