import type { Tx } from "../../db/sql.js";
import { notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";

export type DocumentSubjectType = "learner" | "guardian" | "staff";

/**
 * Public document metadata.
 *
 * F-04: the storage key is server-generated and is NEVER returned. `storage_status` is
 * `metadata_only` for every row today: no object exists, so there is nothing to upload to,
 * download, scan or retain. `object_available` is a constant `false` until a later migration
 * and an approved storage integration say otherwise (see PHASE3-DOCUMENT-STORAGE-CONTRACT.md).
 */
export interface PublicDirectoryDocument {
  id: string;
  tenantId: string;
  subject_type: DocumentSubjectType;
  subject_id: string;
  doc_type: string;
  file_name: string;
  content_type: string | null;
  byte_size: number | null;
  storage_status: "metadata_only";
  object_available: false;
  uploaded_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_NAME = /[\\/\u0000-\u001f\u007f]/;
/**
 * P3-AUDIT-013: `doc_type` is free text chosen by the caller and is copied into the
 * `directory.document.registered` audit detail. It is already bounded to 64 characters by the
 * schema and the database CHECK; control characters are additionally refused so a value cannot
 * carry line breaks or terminal escapes into an audit record or an operator's console. The
 * character set is otherwise left open: real values are things like `birth_certificate`,
 * `KCPE result slip` or `Ripoti ya afya`, and narrowing it further would reject them.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_DOC_TYPE = /[\u0000-\u001f\u007f]/;
const CONTENT_TYPE_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

const SELECT_COLS = `
  id, tenant_id, subject_type, subject_id, doc_type, file_name, content_type,
  byte_size, storage_status, uploaded_by, archived_at, created_at, updated_at
`;

interface DocumentRow {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  doc_type: string;
  file_name: string;
  content_type: string | null;
  byte_size: string | number | null;
  storage_status: string;
  uploaded_by: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function isoStamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function mapPublic(row: DocumentRow): PublicDirectoryDocument {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject_type: row.subject_type as DocumentSubjectType,
    subject_id: row.subject_id,
    doc_type: row.doc_type,
    file_name: row.file_name,
    content_type: row.content_type,
    byte_size: row.byte_size == null ? null : Number(row.byte_size),
    storage_status: "metadata_only",
    object_available: false,
    uploaded_by: row.uploaded_by,
    archived_at: row.archived_at == null ? null : isoStamp(row.archived_at),
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

async function assertSubjectExists(
  db: Tx,
  tenantId: string,
  subjectType: DocumentSubjectType,
  subjectId: string,
): Promise<void> {
  let result;
  if (subjectType === "learner") {
    result = await db.query(`SELECT 1 FROM learners WHERE id = $1 AND tenant_id = $2`, [
      subjectId,
      tenantId,
    ]);
  } else if (subjectType === "guardian") {
    result = await db.query(`SELECT 1 FROM guardians WHERE id = $1 AND tenant_id = $2`, [
      subjectId,
      tenantId,
    ]);
  } else {
    result = await db.query(`SELECT 1 FROM staff_members WHERE id = $1 AND tenant_id = $2`, [
      subjectId,
      tenantId,
    ]);
  }
  if (!result.rows[0]) throw notFound(`${subjectType} not found`);
}

export async function registerDocument(
  db: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    subject_type: DocumentSubjectType;
    subject_id: string;
    doc_type: string;
    file_name: string;
    content_type?: string | null;
    byte_size?: number | null;
    ip?: string | null;
  },
): Promise<PublicDirectoryDocument> {
  const doc_type = input.doc_type.trim();
  const file_name = input.file_name.trim();
  if (!doc_type || doc_type.length > 64 || UNSAFE_DOC_TYPE.test(doc_type)) {
    throw validationError("doc_type is invalid");
  }
  // File names become Content-Disposition values later: no separators, no control characters.
  if (!file_name || file_name.length > 255 || file_name === "." || file_name === ".." || UNSAFE_FILE_NAME.test(file_name)) {
    throw validationError("file_name is invalid");
  }
  if (input.content_type != null && !CONTENT_TYPE_SHAPE.test(input.content_type)) {
    throw validationError("content_type must look like type/subtype");
  }

  await assertSubjectExists(db, input.tenantId, input.subject_type, input.subject_id);

  const result = await db.query<DocumentRow>(
    `INSERT INTO directory_documents (
       tenant_id, subject_type, subject_id, doc_type, file_name,
       content_type, byte_size, uploaded_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${SELECT_COLS}`,
    [
      input.tenantId,
      input.subject_type,
      input.subject_id,
      doc_type,
      file_name,
      input.content_type ?? null,
      input.byte_size ?? null,
      input.actorUserId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("document insert returned no row");
  await recordSecurityEvent(db, {
    eventType: "directory.document.registered",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      documentId: row.id,
      subject_type: input.subject_type,
      subject_id: input.subject_id,
      doc_type,
    },
    ip: input.ip ?? null,
  });
  return mapPublic(row);
}

export async function getDocumentById(
  db: Tx,
  input: { tenantId: string; documentId: string },
): Promise<PublicDirectoryDocument> {
  const result = await db.query<DocumentRow>(
    `SELECT ${SELECT_COLS} FROM directory_documents WHERE id = $1 AND tenant_id = $2`,
    [input.documentId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Document not found");
  return mapPublic(row);
}

export async function listDocumentsPage(
  db: Tx,
  input: {
    tenantId: string;
    limit: number;
    cursorKeys?: string[] | null;
    subject_type?: DocumentSubjectType | null;
    subject_id?: string | null;
    includeArchived?: boolean;
    /** Subject types the caller may NOT see (F-01: guardian documents need resource.guardian.read). */
    excludeSubjectTypes?: DocumentSubjectType[];
  },
): Promise<Array<PublicDirectoryDocument & { _sort_created: string }>> {
  const params: unknown[] = [input.tenantId];
  const filters = [`tenant_id = $1`];
  if (!input.includeArchived) filters.push(`archived_at IS NULL`);
  if (input.subject_type) {
    params.push(input.subject_type);
    filters.push(`subject_type = $${params.length}`);
  }
  if (input.subject_id) {
    params.push(input.subject_id);
    filters.push(`subject_id = $${params.length}`);
  }
  if (input.excludeSubjectTypes?.length) {
    params.push(input.excludeSubjectTypes);
    filters.push(`subject_type <> ALL($${params.length}::text[])`);
  }
  let keyset = "";
  if (input.cursorKeys?.length === 2) {
    params.push(input.cursorKeys[0], input.cursorKeys[1]);
    keyset = `AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(input.limit + 1);
  const result = await db.query<DocumentRow & { sort_created: string }>(
    `SELECT ${SELECT_COLS},
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created
       FROM directory_documents
      WHERE ${filters.join(" AND ")}
      ${keyset}
      ORDER BY created_at ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    ...mapPublic(row),
    _sort_created: row.sort_created,
  }));
}

export async function archiveDocument(
  db: Tx,
  input: { tenantId: string; documentId: string; actorUserId: string; ip?: string | null },
): Promise<PublicDirectoryDocument> {
  const result = await db.query<DocumentRow>(
    `UPDATE directory_documents
        SET archived_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL
      RETURNING ${SELECT_COLS}`,
    [input.documentId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    const existing = await getDocumentById(db, input);
    if (existing.archived_at) throw validationError("Document is already archived");
    throw notFound("Document not found");
  }
  await recordSecurityEvent(db, {
    eventType: "directory.document.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { documentId: row.id },
    ip: input.ip ?? null,
  });
  return mapPublic(row);
}
