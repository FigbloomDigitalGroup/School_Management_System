import { supabase } from "@figbloom/shared";

/**
 * Two buckets (see supabase/migrations/20260903000001_uploads.sql for the
 * storage RLS): `public-assets` for avatars/branding — publicly readable,
 * staff-only write — and `private-documents` for student records, payment
 * proof and assignment hand-ins — tenant-readable, staff-write plus two
 * narrow self-service carve-outs (a guardian for their own child's invoice,
 * a student for their own submission).
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

/** A staff/student photo. Staff-only write, so call this from an admin/staff screen. */
export async function uploadAvatar(
  tenantId: string,
  ownerKind: "students" | "staff",
  ownerId: string,
  file: File,
): Promise<string> {
  const path = `${tenantId}/avatars/${ownerKind}-${ownerId}.${extOf(file.name)}`;
  await uploadToBucket("public-assets", path, file);
  return publicAssetUrl(path);
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
  file_path: string;
  file_name: string;
  note: string | null;
  status: "pending" | "confirmed" | "rejected";
  uploaded_at: string;
}

/** A bank-slip/receipt photo against one invoice — guardians upload their own child's, staff can too. */
export async function uploadPaymentProof(input: {
  tenantId: string; invoiceId: string; uploadedBy: string; note?: string; file: File;
}): Promise<void> {
  const path = `${input.tenantId}/invoices/${input.invoiceId}/${Date.now()}-${input.file.name}`;
  await uploadToBucket("private-documents", path, input.file);
  const { error } = await supabase().from("payment_proofs").insert({
    tenant_id: input.tenantId,
    invoice_id: input.invoiceId,
    uploaded_by: input.uploadedBy,
    file_path: path,
    file_name: input.file.name,
    note: input.note ?? null,
  });
  if (error) throw error;
}

export async function listPaymentProofs(invoiceId: string): Promise<PaymentProof[]> {
  const { data, error } = await supabase()
    .from("payment_proofs")
    .select("id, invoice_id, file_path, file_name, note, status, uploaded_at")
    .eq("invoice_id", invoiceId)
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PaymentProof[];
}
