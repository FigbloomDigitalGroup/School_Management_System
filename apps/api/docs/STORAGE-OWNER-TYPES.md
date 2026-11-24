# Storage owner types (design note, S6 part 1)

Status: API side built and tested against a throwaway database. Nothing on the web uses it yet (part 2). S3 is still not
configured in any deployed environment.

## The flow (unchanged)

`POST /v1/tenants/{t}/storage/objects` (declare type, name, content type, size) → `PUT` the exact bytes to the presigned URL
with every header in `requiredHeaders` → `POST …/objects/{id}/complete` (the API checks the stored size and type and throws
away a mismatch) → `POST …/objects/{id}/download-url` for a short-lived link, `DELETE …/objects/{id}` to remove. Records
keep the object id, never a bucket path. The object key is made by the database (`tenants/<school>/<type>/<id>`). The
table keeps forced RLS, its `figbloom_app` tenant policy and its grants from migration 090; migration 102 only widens the
type check and adds one owner rule.

## Owner types (migration `102_storage_owner_types.sql`, code `src/modules/storage/ownerTypes.ts`)

| Type | Staff write (start, finish, delete) | Staff read (metadata, download) | Also allowed | Content types, size | `owner_resource_id` |
|---|---|---|---|---|---|
| `directory_document`, `export_artifact`, `medication_authorization`, `general` | `resource.document.write` | `resource.document.read` | nobody else | standard list, 25 MiB | optional |
| `payment_proof` | `resource.finance.administer` (as `POST /finance/proofs`) | `resource.finance.read` | a parent of the learner on that invoice: start, finish own upload, read; never delete | JPEG, PNG, WebP, PDF, 10 MiB (as `POST /finance/proofs`) | required: an invoice of this school |
| `homework_attachment`, `learning_material`, `exam_paper` | `resource.academics.write` (as the homework, materials and paper endpoints) | `resource.academics.read` | nobody else | standard list, 25 MiB | optional |
| `avatar` | `resource.document.write` (People area) | `resource.document.read` | any member, for the photo naming their own user id: start, finish own upload, read, delete | JPEG, PNG, WebP, 5 MiB | required: a learner or a member of this school |
| `school_logo` | `resource.school_profile.write` (full administrators) | `resource.school_profile.read` | any member of the school may read it | JPEG, PNG, WebP, 5 MiB | optional |

Standard list: PDF, JPEG, PNG, WebP, CSV, plain text, JSON, XLSX, DOCX.

Rules that hold for every type:

- The school comes from the authorised request (path + session or `X-Tenant-Id`), never from the body, and every read is
  filtered by school and by RLS. A school B administrator gets 403 naming school A, and 404 for school A's object ids in
  their own school.
- "A member" means a live membership of this school. An organisation administrator without a delegation is not one.
- A family path is checked live on every call (`family_my_children()`): a revoked link closes it at once.
- A caller with no staff permission for the action gets the same 403 for a missing object and for someone else's object,
  so object ids cannot be probed. Staff get 404 for a missing object, as before.
- `owner_resource_id` cannot change after creation (trigger from 090), and the database refuses a payment proof or avatar
  without one (`storage_objects_owner_id_required_chk`).
- The OpenAPI `x-figbloom-permissions` still lists `resource.document.*` (true for the sample request the RBAC matrix
  sends); each operation's `description` states the per-type rules.

## Not done here (part 2 and later)

1. Web: the API branch of `packages/shared/src/files.ts` (start, PUT with `requiredHeaders`, complete, download link,
   delete), then the pages: `admin/papers` and `teacher/exams` (`ExamPapers.tsx`), `admin/materials` and
   `teacher/materials` (`LearningMaterials.tsx`), `teacher/homework` (`Homework.tsx`). `onlineClasses` stays hidden.
2. A local S3 stand-in for browser checks (for example a MinIO container: `S3_ENDPOINT`, path-style, a bucket, keys), and
   CORS on that bucket for the web origin.
3. The web content security policy (`apps/web/vercel.json`, S5) must allow the S3 origin in `connect-src` (PUT) and
   wherever downloads are shown (`img-src` for photos and the crest).
4. No record links a file yet: `homework_items`, `learning_materials`, `online_exam_papers`, `finance_payment_proofs`
   (metadata only), `school_profiles.logo_object_key` (forced NULL by migration 028) and no avatar column. Each needs a
   `storage_object_id` column (same school, foreign key `(id, tenant_id)`) and the endpoint that sets it.
5. Families cannot read homework, material or exam-paper files, and plain teachers cannot reach academic files (they lack
   `resource.academics.*`, like the endpoints that create those records). Once a record links its file, read access
   should follow "may read the record", including the family reads.
6. Big videos for learning materials (the legacy bucket took up to 2 GB): not allowed here (25 MiB, no video types, single
   PUT). Needs multipart upload and a product decision.
7. A medication authorization's `supporting_document_id` does not check the object's owner type (pre-existing; staff
   only).
