import type { Tx } from "../../db/sql.js";
import { pageQuery, type Page, type PageInput } from "./pagination.js";

function isoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function isoStamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

export interface PublicCurriculumReferenceEntry {
  id: string;
  provenance_id: string;
  entry_kind: string;
  code: string;
  title: string;
  body: string | null;
  education_level: string | null;
  grade_band: string | null;
  pathway: string | null;
  parent_code: string | null;
  source_organisation: string;
  source_title: string;
  source_uri: string | null;
  source_document_id: string | null;
  publication_or_version: string | null;
  retrieved_at: string;
  verification_status: "unverified" | "verified" | "incomplete";
  known_limitations: string | null;
  /** Always false: progressive platform reference is never a complete official catalogue claim. */
  official_catalogue: false;
  created_at: string;
}

type EntryRow = {
  id: string;
  provenance_id: string;
  entry_kind: string;
  code: string;
  title: string;
  body: string | null;
  education_level: string | null;
  grade_band: string | null;
  pathway: string | null;
  parent_code: string | null;
  source_organisation: string;
  source_title: string;
  source_uri: string | null;
  source_document_id: string | null;
  publication_or_version: string | null;
  retrieved_at: Date | string;
  verification_status: "unverified" | "verified" | "incomplete";
  known_limitations: string | null;
  created_at: Date | string;
};

const ENTRY_COLS = `id, provenance_id, entry_kind, code, title, body, education_level, grade_band, pathway,
  parent_code, source_organisation, source_title, source_uri, source_document_id, publication_or_version,
  retrieved_at, verification_status, known_limitations, created_at`;

function mapEntry(row: EntryRow): PublicCurriculumReferenceEntry {
  return {
    id: row.id,
    provenance_id: row.provenance_id,
    entry_kind: row.entry_kind,
    code: row.code,
    title: row.title,
    body: row.body,
    education_level: row.education_level,
    grade_band: row.grade_band,
    pathway: row.pathway,
    parent_code: row.parent_code,
    source_organisation: row.source_organisation,
    source_title: row.source_title,
    source_uri: row.source_uri,
    source_document_id: row.source_document_id,
    publication_or_version: row.publication_or_version,
    retrieved_at: isoDate(row.retrieved_at),
    verification_status: row.verification_status,
    known_limitations: row.known_limitations,
    official_catalogue: false,
    created_at: isoStamp(row.created_at),
  };
}

export async function listCurriculumReferenceEntries(
  tx: Tx,
  input: {
    entryKind?: string;
    verificationStatus?: string;
    page: PageInput;
    id?: string;
  },
): Promise<Page<PublicCurriculumReferenceEntry>> {
  const params: unknown[] = [];
  const parts: string[] = ["true"];
  if (input.entryKind) {
    params.push(input.entryKind);
    parts.push(`entry_kind = $${params.length}`);
  }
  if (input.verificationStatus) {
    params.push(input.verificationStatus);
    parts.push(`verification_status = $${params.length}`);
  }
  const res = await pageQuery<{ id: string }>(
    tx,
    `SELECT ${ENTRY_COLS} FROM curriculum_reference_entries WHERE ${parts.join(" AND ")}`,
    params,
    { name: "curriculum_reference_entries", expr: "lower(q.code)", type: "text", dir: "asc" },
    input.page,
    input.id,
  );
  return { items: (res.rows as unknown as EntryRow[]).map(mapEntry), page: res.page };
}
