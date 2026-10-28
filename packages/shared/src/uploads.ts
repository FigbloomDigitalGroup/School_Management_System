import { safeFileName } from "./materials";
import { supabase } from "./supabase";

/**
 * Uploads from the phone apps. The web app uploads a browser File; React
 * Native has no File, so the phone reads a picked photo into a Blob
 * (fetch(uri).blob()) and hands it over with the name and type to store it
 * under. Same buckets and path rules as the web, which the database checks.
 */

export interface UploadableFile {
  blob: Blob;
  name: string;
  /** What to store it as, e.g. "image/jpeg"; the bucket refuses types it doesn't allow. */
  mimeType: string;
}

/** The most a phone sends in one go: the hosted project's own cap, as on the web (VITE_MAX_UPLOAD_MB). */
export const PHONE_UPLOAD_LIMIT_BYTES = 50 * 1024 ** 2;

/** Why this file can't be sent, or null. A photo the phone hasn't measured (size null) is let through: the server still refuses what is too big. */
export function uploadProblem(file: { name: string; sizeBytes: number | null }, limitBytes: number = PHONE_UPLOAD_LIMIT_BYTES): string | null {
  if (file.sizeBytes !== null && file.sizeBytes > limitBytes) {
    return `That photo is ${(file.sizeBytes / 1024 ** 2).toFixed(1)} MB; the most that can be sent is ${Math.round(limitBytes / 1024 ** 2)} MB.`;
  }
  return null;
}

/** "jpg" from "scan.JPG"; "bin" when there is none. */
export function fileExtension(fileName: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(fileName);
  return m ? m[1]!.toLowerCase() : "bin";
}

export const PRIVATE_DOCS_BUCKET = "private-documents";

/** Where a prescription photo lives: the child's own medical folder, which the database lets their guardians write (20261101300001). */
export function prescriptionPath(tenantId: string, studentId: string, fileName: string, now: number = Date.now()): string {
  return `${tenantId}/medical/${studentId}/${now}-prescription.${fileExtension(safeFileName(fileName))}`;
}

/** Puts a prescription photo in the child's medical folder; returns the path for the medication request to name. */
export async function uploadPrescriptionFile(tenantId: string, studentId: string, file: UploadableFile): Promise<string> {
  const path = prescriptionPath(tenantId, studentId, file.name);
  const { error } = await supabase().storage.from(PRIVATE_DOCS_BUCKET).upload(path, file.blob, { contentType: file.mimeType, upsert: false });
  if (error) throw new Error(error.message);
  return path;
}

/** Takes back a prescription photo whose request was never saved. Best effort: a guardian may not be allowed to delete. */
export async function removeUnsentPrescription(path: string): Promise<void> {
  await supabase().storage.from(PRIVATE_DOCS_BUCKET).remove([path]).catch(() => {});
}
