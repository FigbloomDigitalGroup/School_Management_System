import { sha256Hex, supabase } from "@figbloom/shared";

/**
 * The file's SHA-256 as the signer downloaded it: what their signature vouches
 * for. Web-only: it needs Blob.arrayBuffer(), which React Native's Blob lacks.
 */
export async function fileHash(bucket: string, path: string): Promise<string> {
  const { data, error } = await supabase().storage.from(bucket).download(path);
  if (error || !data) throw new Error(error?.message ?? "Could not fetch the file to sign.");
  return sha256Hex(await data.arrayBuffer());
}
