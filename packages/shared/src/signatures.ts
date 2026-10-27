import { bytesToHex, sha256, utf8Bytes } from "./sha256";
import { supabase } from "./supabase";

/**
 * Electronic signatures (supabase/migrations/20261027050000_e_signatures.sql).
 *
 * A drawn signature is kept as strokes, not a picture: each stroke a flat
 * list of whole-number points [x, y, x, y, ...] in a SIGNATURE_BOX-sized
 * box. That stays small in the database, draws crisply at any size on screen
 * (an SVG path) and in a PDF (pdf-lib's drawSvgPath), and needs no storage
 * bucket or policies of its own. A typed signature has no strokes: the name
 * is the mark.
 */

export type SignedDocKind = "student_document" | "attachment" | "report_card" | "fee_invoice";
export type SignerCapacity = "guardian" | "learner" | "staff" | "recipient" | "principal" | "class_teacher" | "bursar";
export type SignatureStyle = "drawn" | "typed";
export type Stroke = number[];

export const SIGNATURE_BOX = { width: 600, height: 200 } as const;
/** Enough for a long signature; the database caps the strokes at 40 KB. */
export const MAX_SIGNATURE_POINTS = 3000;

export const CAPACITY_LABEL: Record<SignerCapacity, string> = {
  guardian: "Parent / guardian",
  learner: "Learner",
  staff: "Staff",
  recipient: "Parent / guardian",
  principal: "Principal",
  class_teacher: "Class teacher",
  bursar: "Bursar",
};

export interface SignatureMark {
  fullName: string;
  style: SignatureStyle;
  /** Drawn only. */
  strokes: Stroke[] | null;
}

/**
 * Pointer positions from a pad of any size into the signature box: scaled,
 * rounded to whole numbers, kept inside the box, with points closer than a
 * couple of units to the last one dropped. A tap stays as a one-point dot.
 */
export function normaliseStrokes(raw: { x: number; y: number }[][], padWidth: number, padHeight: number): Stroke[] {
  if (padWidth <= 0 || padHeight <= 0) return [];
  const sx = SIGNATURE_BOX.width / padWidth;
  const sy = SIGNATURE_BOX.height / padHeight;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));
  const out: Stroke[] = [];
  let total = 0;
  for (const points of raw) {
    const stroke: Stroke = [];
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const x = clamp(p.x * sx, SIGNATURE_BOX.width);
      const y = clamp(p.y * sy, SIGNATURE_BOX.height);
      const n = stroke.length;
      if (n >= 2 && Math.hypot(x - stroke[n - 2]!, y - stroke[n - 1]!) < 2) continue;
      if (total >= MAX_SIGNATURE_POINTS) break;
      stroke.push(x, y);
      total++;
    }
    if (stroke.length) out.push(stroke);
  }
  return out;
}

/** How far the pen travelled, in box units: a signature, not a stray tap. */
export function inkLength(strokes: Stroke[]): number {
  let len = 0;
  for (const s of strokes) for (let i = 2; i + 1 < s.length; i += 2) len += Math.hypot(s[i]! - s[i - 2]!, s[i + 1]! - s[i - 1]!);
  return len;
}

/** Why this mark can't be signed with yet, or null when it can. */
export function signatureProblem(mark: SignatureMark): string | null {
  const name = mark.fullName.trim();
  if (name.length < 2) return "Type your full name.";
  if (name.length > 120) return "That name is too long.";
  if (mark.style === "drawn" && (!mark.strokes || inkLength(mark.strokes) < 40)) return "Draw your signature in the box.";
  return null;
}

/** The smallest box around the ink, or null for none. */
export function strokeBounds(strokes: Stroke[]): { minX: number; minY: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      minX = Math.min(minX, s[i]!); maxX = Math.max(maxX, s[i]!);
      minY = Math.min(minY, s[i + 1]!); maxY = Math.max(maxY, s[i + 1]!);
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * The strokes as one SVG path. With crop, moved so the ink starts at 0,0 (for
 * fitting into a small space, like a PDF signature line). A one-point stroke
 * becomes a short dash so a dotted i still shows.
 */
export function strokesToSvgPath(strokes: Stroke[], opts: { crop?: boolean } = {}): string {
  const b = opts.crop ? strokeBounds(strokes) : null;
  const dx = b?.minX ?? 0;
  const dy = b?.minY ?? 0;
  const parts: string[] = [];
  for (const s of strokes) {
    if (s.length < 2) continue;
    parts.push(`M${s[0]! - dx} ${s[1]! - dy}`);
    if (s.length === 2) parts.push(`L${s[0]! - dx + 1} ${s[1]! - dy}`);
    for (let i = 2; i + 1 < s.length; i += 2) parts.push(`L${s[i]! - dx} ${s[i + 1]! - dy}`);
  }
  return parts.join(" ");
}

/** Strokes as they come back from the database, or null if they aren't strokes. */
export function parseStrokes(value: unknown): Stroke[] | null {
  if (!Array.isArray(value)) return null;
  const out: Stroke[] = [];
  for (const s of value) {
    if (!Array.isArray(s) || s.length % 2 !== 0 || !s.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    out.push(s as number[]);
  }
  return out;
}

// This file also compiles for the mobile apps (lib ES2022, no DOM), where
// these web globals have no types. Browsers, Node 20 and Deno have them all;
// React Native's Hermes has no crypto.subtle, so it falls back to sha256.ts.
const web = globalThis as unknown as {
  crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  navigator?: { userAgent?: string };
};

/** SHA-256 as lowercase hex, of bytes or of text (UTF-8). */
export async function sha256Hex(input: Uint8Array | ArrayBuffer | string): Promise<string> {
  const bytes = typeof input === "string" ? utf8Bytes(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const subtle = web.crypto?.subtle;
  return bytesToHex(subtle ? new Uint8Array(await subtle.digest("SHA-256", bytes)) : sha256(bytes));
}

/** "26 Oct 2026", the date written beside a signature. */
export function signatureDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ---------------------------------------------------------------- data

export interface StoredSignature {
  id: string;
  docId: string;
  signerId: string | null;
  capacity: SignerCapacity;
  fullName: string;
  style: SignatureStyle;
  strokes: Stroke[] | null;
  signedAt: string;
  /** False when the document changed after signing; null for files (not checked). */
  isCurrent: boolean | null;
}

export interface SignatureRequest {
  requestId: string;
  docKind: SignedDocKind;
  docId: string;
  capacity: SignerCapacity;
  title: string;
  detail: string;
  bucket: string;
  filePath: string | null;
  fileName: string | null;
  note: string | null;
  requestedByName: string | null;
  requestedAt: string;
}

export interface SignatureStatusRow {
  docId: string;
  signerId: string;
  signerName: string;
  capacity: SignerCapacity;
  requestedAt: string;
  signedAt: string | null;
}

/**
 * Signs documents of one kind with one mark. Files need their hashes, in the
 * same order as ids (fileHash() in the web app); rows are hashed by the database.
 * Returns how many were newly signed (already signed and unchanged are skipped).
 */
export async function signDocuments(kind: SignedDocKind, ids: string[], capacity: SignerCapacity, mark: SignatureMark, hashes?: string[]): Promise<number> {
  const problem = signatureProblem(mark);
  if (problem) throw new Error(problem);
  const { data, error } = await supabase().rpc("sign_documents", {
    p_kind: kind,
    p_ids: ids,
    p_capacity: capacity,
    p_full_name: mark.fullName.trim(),
    p_style: mark.style,
    p_strokes: mark.style === "drawn" ? mark.strokes : null,
    p_hashes: hashes ?? null,
    p_user_agent: web.navigator?.userAgent?.slice(0, 400) ?? null,
  });
  if (error) throw new Error(error.message);
  return (data as number | null) ?? 0;
}

export async function fetchDocumentSignatures(kind: SignedDocKind, ids: string[]): Promise<StoredSignature[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase().rpc("document_signatures", { p_kind: kind, p_ids: ids });
  if (error) throw new Error(error.message);
  return ((data ?? []) as {
    id: string; doc_id: string; signer_id: string | null; capacity: SignerCapacity; full_name: string;
    style: SignatureStyle; strokes: unknown; signed_at: string; is_current: boolean | null;
  }[]).map((r) => ({
    id: r.id, docId: r.doc_id, signerId: r.signer_id, capacity: r.capacity, fullName: r.full_name,
    style: r.style, strokes: parseStrokes(r.strokes), signedAt: r.signed_at, isCurrent: r.is_current,
  }));
}

export async function fetchMySignatureRequests(): Promise<SignatureRequest[]> {
  const { data, error } = await supabase().rpc("my_signature_requests");
  if (error) throw new Error(error.message);
  return ((data ?? []) as {
    request_id: string; doc_kind: SignedDocKind; doc_id: string; capacity: SignerCapacity; title: string | null; detail: string | null;
    bucket: string; file_path: string | null; file_name: string | null; note: string | null; requested_by_name: string | null; requested_at: string;
  }[]).map((r) => ({
    requestId: r.request_id, docKind: r.doc_kind, docId: r.doc_id, capacity: r.capacity, title: r.title ?? "Document",
    detail: r.detail ?? "", bucket: r.bucket, filePath: r.file_path, fileName: r.file_name, note: r.note,
    requestedByName: r.requested_by_name, requestedAt: r.requested_at,
  }));
}

export async function fetchSignatureStatus(kind: SignedDocKind, ids: string[]): Promise<SignatureStatusRow[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase().rpc("signature_status", { p_kind: kind, p_ids: ids });
  if (error) throw new Error(error.message);
  return ((data ?? []) as {
    doc_id: string; signer_id: string; signer_name: string; capacity: SignerCapacity; requested_at: string; signed_at: string | null;
  }[]).map((r) => ({
    docId: r.doc_id, signerId: r.signer_id, signerName: r.signer_name, capacity: r.capacity, requestedAt: r.requested_at, signedAt: r.signed_at,
  }));
}

/** Asks guardians, the learner or staff to sign a learner's document. Returns how many were newly asked. */
export async function requestSignatures(docId: string, signerIds: string[], note?: string): Promise<number> {
  const { data, error } = await supabase().rpc("request_signatures", { p_doc_id: docId, p_signer_ids: signerIds, p_note: note ?? null });
  if (error) throw new Error(error.message);
  return (data as number | null) ?? 0;
}

export async function voidSignature(id: string, reason: string): Promise<void> {
  const { error } = await supabase().rpc("void_signature", { p_id: id, p_reason: reason });
  if (error) throw new Error(error.message);
}

/**
 * Marks a message's files as needing a signature. Call before sending: the
 * families it reaches are asked as it goes out.
 */
export async function requireAttachmentSignatures(announcementId: string): Promise<void> {
  const { error } = await supabase().from("attachments").update({ needs_signature: true })
    .eq("announcement_id", announcementId).not("file_path", "is", null);
  if (error) throw new Error(error.message);
}

/** "12 of 30 signed" per document, from signature_status rows. */
export function signatureTally(rows: SignatureStatusRow[]): Map<string, { signed: number; asked: number }> {
  const out = new Map<string, { signed: number; asked: number }>();
  for (const r of rows) {
    const t = out.get(r.docId) ?? { signed: 0, asked: 0 };
    t.asked++;
    if (r.signedAt) t.signed++;
    out.set(r.docId, t);
  }
  return out;
}

/** The live signature in one capacity on one document, if any: what the report-card PDF stamps. */
export function signatureFor(signatures: StoredSignature[], docId: string, capacity: SignerCapacity, opts: { currentOnly?: boolean } = {}): StoredSignature | undefined {
  return signatures.find((s) => s.docId === docId && s.capacity === capacity && (!opts.currentOnly || s.isCurrent !== false));
}
