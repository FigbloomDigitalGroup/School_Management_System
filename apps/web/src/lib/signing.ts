import { downloadFile, sha256Hex } from "@figbloom/shared";

/**
 * The file's SHA-256 as the signer downloaded it: what their signature vouches
 * for. Web-only: it needs Blob.arrayBuffer(), which React Native's Blob lacks.
 */
export async function fileHash(bucket: string, path: string): Promise<string> {
  const data = await downloadFile(bucket, path);
  return sha256Hex(await data.arrayBuffer());
}
