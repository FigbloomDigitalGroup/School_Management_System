import { sha256Hex, supabase } from "@figbloom/shared";

/**
 * The file's SHA-256 as the signer receives it: what their signature vouches
 * for. The web app downloads through Blob.arrayBuffer(), which React Native's
 * Blob lacks, so this reads the bytes of a short-lived signed link instead.
 */
export async function fileHash(bucket: string, path: string): Promise<string> {
  const { data, error } = await supabase().storage.from(bucket).createSignedUrl(path, 300);
  if (error || !data) throw new Error(error?.message ?? "Could not fetch the file to sign.");
  const res = await fetch(data.signedUrl);
  if (!res.ok) throw new Error("Could not fetch the file to sign.");
  return sha256Hex(await res.arrayBuffer());
}
