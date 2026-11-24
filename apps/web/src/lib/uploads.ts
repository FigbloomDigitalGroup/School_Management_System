import {
  deleteFiles, examPaperFilePath, insertPaymentProofRecord, insertStudentDocument, listPaymentProofs as sharedListPaymentProofs,
  listStudentDocuments as sharedListStudentDocuments, paperImportPath, privateDocumentUrl, publicFileUrl, storeFile, upsertAssignmentSubmission,
  type ParsedPaymentSms, type PaymentProof, type StudentDocumentRecord,
} from "@figbloom/shared";

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
  await storeFile(bucket, path, file, file.type || "application/octet-stream", { upsert: true });
}

export function publicAssetUrl(path: string): string {
  return publicFileUrl(path);
}

/** A signed, time-limited URL — private-documents has no public read. */
export const privateDocUrl = privateDocumentUrl;

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

export type StudentDocument = StudentDocumentRecord;

/** A record attached to a learner — birth certificate, medical form, etc. Staff only. */
export async function uploadStudentDocument(input: {
  tenantId: string; studentId: string; uploadedBy: string; docType: string; file: File;
}): Promise<void> {
  const path = `${input.tenantId}/students/${input.studentId}/${Date.now()}-${input.file.name}`;
  await uploadToBucket("private-documents", path, input.file);
  await insertStudentDocument({
    tenantId: input.tenantId,
    studentId: input.studentId,
    uploadedBy: input.uploadedBy,
    docType: input.docType,
    filePath: path,
    fileName: input.file.name,
  });
}

export const listStudentDocuments = sharedListStudentDocuments;

/** A student's own hand-in for one assignment — separate from the local-only "mark as handed in" toggle. */
export async function uploadAssignmentSubmission(input: {
  tenantId: string; assignmentId: string; studentId: string; file: File;
}): Promise<void> {
  const path = `${input.tenantId}/submissions/${input.assignmentId}/${input.studentId}/${Date.now()}-${input.file.name}`;
  await uploadToBucket("private-documents", path, input.file);
  await upsertAssignmentSubmission({
    assignmentId: input.assignmentId,
    studentId: input.studentId,
    filePath: path,
    fileName: input.file.name,
  });
}

export type { PaymentProof };

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
  try {
    await insertPaymentProofRecord({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      uploadedBy: input.uploadedBy,
      filePath: path,
      fileName: input.file?.name ?? null,
      note: input.note,
      sms: input.sms,
    });
  } catch (error) {
    // The file went up but the proof was refused (most often a reused code). Staff
    // can take the file back out; a family can't delete from the bucket, so theirs
    // stays as an unlinked private file rather than a proof row with no evidence.
    if (path) await deleteFiles("private-documents", [path]).catch(() => {});
    throw error;
  }
}

/**
 * A photo of a prescription, sent with a guardian's medication request
 * (20261101300000). Goes in the child's own medical folder, which only the
 * child's guardians, the medical area and full admins can open
 * (20261101300001); returns the path for the request to name.
 */
export async function uploadPrescription(input: { tenantId: string; studentId: string; file: File }): Promise<string> {
  const path = `${input.tenantId}/medical/${input.studentId}/${Date.now()}-prescription.${extOf(input.file.name)}`;
  await uploadToBucket("private-documents", path, input.file);
  return path;
}

export const listPaymentProofs = sharedListPaymentProofs;

/**
 * A paper for Bloom to import, waiting in the importer's own folder. The
 * ai-assist function deletes it once read; removePaperImportFiles() tidies
 * up when the request never got that far.
 */
export async function uploadPaperImportFiles(input: { tenantId: string; profileId: string; files: File[] }): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const file of input.files) {
      const path = paperImportPath(input.tenantId, input.profileId, crypto.randomUUID(), file.name);
      await uploadToBucket("private-documents", path, file);
      paths.push(path);
    }
    return paths;
  } catch (err) {
    await removePaperImportFiles(paths);
    throw err;
  }
}

export async function removePaperImportFiles(paths: string[]): Promise<void> {
  await deleteFiles("private-documents", paths);
}

/** An exam paper's PDF (or reference sheet). Staff write it; families can read it once the paper opens (private_docs_exam_papers_read). */
export async function uploadExamPaperFile(input: { tenantId: string; paperId: string; file: File }): Promise<{ path: string; name: string }> {
  const path = examPaperFilePath(input.tenantId, input.paperId, input.file.name);
  await uploadToBucket("private-documents", path, input.file);
  return { path, name: input.file.name };
}
