import { examPaperFilePath, supabase, type ParsedPaymentSms } from "@figbloom/shared";

/**
 * Two buckets (see supabase/migrations/20260903000001_uploads.sql for the
 * storage RLS): `public-assets` for avatars/branding — publicly readable,
 * staff-only write — and `private-documents` for student records, payment
 * proof and assignment hand-ins — tenant-readable, staff-write plus two
 * narrow self-service carve-outs (a guardian for their own child's invoice,
 * a student for their own submission).
 *
 * Learning materials and files on announcements and homework go to a third
 * bucket, `learning-media`, through lib/resumableUpload.ts (big videos).
 */

function extOf(filename: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return m ? m[1]!.toLowerCase() : "bin";
}

async function uploadToBucket(bucket: string, path: string, file: File): Promise<void> {
  const { error } = await supabase().storage.from(bucket).upload(path, file, {
    upsert: true,
    contentType: file.type || undefined,
  });
  if (error) throw error;
}

export function publicAssetUrl(path: string): string {
  return supabase().storage.from("public-assets").getPublicUrl(path).data.publicUrl;
}

/** A signed, time-limited URL — private-documents has no public read. */
export async function privateDocUrl(path: string, expiresInSeconds = 3600): Promise<string> {
  const { data, error } = await supabase().storage.from("private-documents").createSignedUrl(path, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

/** A staff/student photo. Staff write any; anyone may write their own staff-{id}
 *  photo (public_assets_own_avatar). Versioned so a replaced photo at the same
 *  path doesn't keep showing the old one from the browser's cache. */
export async function uploadAvatar(
  tenantId: string,
  ownerKind: "students" | "staff",
  ownerId: string,
  file: File,
): Promise<string> {
  const path = `${tenantId}/avatars/${ownerKind}-${ownerId}.${extOf(file.name)}`;
  await uploadToBucket("public-assets", path, file);
  return `${publicAssetUrl(path)}?v=${Date.now()}`;
}

/** The school's crest/logo — feeds tenants.logo_url. */
export async function uploadTenantLogo(tenantId: string, file: File): Promise<string> {
  const path = `${tenantId}/branding/logo.${extOf(file.name)}`;
  await uploadToBucket("public-assets", path, file);
  return publicAssetUrl(path);
}

export interface StudentDocument {
  id: string;
  student_id: string;
  doc_type: string;
  file_path: string;
  file_name: string;
  uploaded_at: string;
}

/** A record attached to a learner — birth certificate, medical form, etc. Staff only. */
export async function uploadStudentDocument(input: {
  tenantId: string; studentId: string; uploadedBy: string; docType: string; file: File;
}): Promise<void> {
  const path = `${input.tenantId}/students/${input.studentId}/${Date.now()}-${input.file.name}`;
  await uploadToBucket("private-documents", path, input.file);
  const { error } = await supabase().from("student_documents").insert({
    tenant_id: input.tenantId,
    student_id: input.studentId,
    uploaded_by: input.uploadedBy,
    doc_type: input.docType,
    file_path: path,
    file_name: input.file.name,
  });
  if (error) throw error;
}

export async function listStudentDocuments(studentId: string): Promise<StudentDocument[]> {
  const { data, error } = await supabase()
    .from("student_documents")
    .select("id, student_id, doc_type, file_path, file_name, uploaded_at")
    .eq("student_id", studentId)
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as StudentDocument[];
}

/** A student's own hand-in for one assignment — separate from the local-only "mark as handed in" toggle. */
export async function uploadAssignmentSubmission(input: {
  tenantId: string; assignmentId: string; studentId: string; file: File;
}): Promise<void> {
  const path = `${input.tenantId}/submissions/${input.assignmentId}/${input.studentId}/${Date.now()}-${input.file.name}`;
  await uploadToBucket("private-documents", path, input.file);
  const { error } = await supabase()
    .from("assignment_submissions")
    .upsert(
      { assignment_id: input.assignmentId, student_id: input.studentId, file_path: path, file_name: input.file.name },
      { onConflict: "assignment_id,student_id" },
    );
  if (error) throw error;
}

export interface PaymentProof {
  id: string;
  invoice_id: string;
  /** Null for a proof that is only a pasted SMS. */
  file_path: string | null;
  file_name: string | null;
  note: string | null;
  status: "pending" | "confirmed" | "rejected";
  uploaded_at: string;
  txn_code: string | null;
  txn_amount_cents: number | null;
  rejection_reason: string | null;
}

/**
 * Proof against one invoice — guardians and learners send their own, staff
 * can too. A bank-slip/receipt photo, the confirmation SMS pasted as text
 * (parsed by parsePaymentSms), or both.
 */
export async function uploadPaymentProof(input: {
  tenantId: string; invoiceId: string; uploadedBy: string; note?: string; file?: File;
  sms?: { text: string; parsed: ParsedPaymentSms };
}): Promise<void> {
  if (!input.file && !input.sms) throw new Error("Add a file or paste the confirmation message.");
  let path: string | null = null;
  if (input.file) {
    path = `${input.tenantId}/invoices/${input.invoiceId}/${Date.now()}-${input.file.name}`;
    await uploadToBucket("private-documents", path, input.file);
  }
  const p = input.sms?.parsed;
  const { error } = await supabase().from("payment_proofs").insert({
    tenant_id: input.tenantId,
    invoice_id: input.invoiceId,
    uploaded_by: input.uploadedBy,
    file_path: path,
    file_name: input.file?.name ?? null,
    note: input.note ?? null,
    sms_text: input.sms?.text.trim() ?? null,
    txn_source: p?.source ?? null,
    txn_code: p?.code ?? null,
    txn_amount_cents: p?.amountCents ?? null,
    txn_at: p?.paidAt ?? null,
    txn_payee: p?.payee ?? null,
    txn_payee_number: p?.payeeNumber ?? null,
    txn_account: p?.account ?? null,
  });
  if (error) {
    // The file went up but the proof was refused (most often a reused code). Staff
    // can take the file back out; a family can't delete from the bucket, so theirs
    // stays as an unlinked private file rather than a proof row with no evidence.
    if (path) await supabase().storage.from("private-documents").remove([path]).catch(() => {});
    throw error;
  }
}

export async function listPaymentProofs(invoiceId: string): Promise<PaymentProof[]> {
  const { data, error } = await supabase()
    .from("payment_proofs")
    .select("id, invoice_id, file_path, file_name, note, status, uploaded_at, txn_code, txn_amount_cents, rejection_reason")
    .eq("invoice_id", invoiceId)
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PaymentProof[];
}

/** An exam paper's PDF (or reference sheet). Staff write it; families can read it once the paper opens (private_docs_exam_papers_read). */
export async function uploadExamPaperFile(input: { tenantId: string; paperId: string; file: File }): Promise<{ path: string; name: string }> {
  const path = examPaperFilePath(input.tenantId, input.paperId, input.file.name);
  await uploadToBucket("private-documents", path, input.file);
  return { path, name: input.file.name };
}
