import { storeFile } from "./files";
import type { UploadableFile } from "./uploads";

/**
 * Puts a file in a storage bucket: the one way every phone upload (chat files, payment proofs, prescriptions, learning
 * materials, a profile photo) goes up. Supabase Storage or S3, whichever files.ts is set up for; React Native's Blob
 * handling is dealt with there.
 */
export async function uploadFile(bucket: string, path: string, file: UploadableFile, options: { upsert?: boolean } = {}): Promise<void> {
  await storeFile(bucket, path, file.blob, file.mimeType, { upsert: options.upsert ?? false });
}
