import { supabase } from "./supabase";
import type { UploadableFile } from "./uploads";

/**
 * Puts a file in a storage bucket: the one way every phone upload (chat files,
 * payment proofs, prescriptions, learning materials, a profile photo) goes up.
 *
 * In a browser or Node it is the storage client's own upload, as it always was.
 * In React Native that cannot work: the client wraps a Blob in a FormData, and
 * the phone's networking only takes text and `{ uri }` parts in a FormData, so
 * the request fails before it is sent, with nothing more than "Network request
 * failed". What React Native does send is a Blob as the request body itself,
 * straight from the phone's storage without passing through JavaScript. So
 * there the file goes to a signed upload URL (the storage client's own way of
 * letting a request without the user's session upload one object, issued only
 * if the user could upload it) as a PUT whose body is the Blob.
 */
export async function uploadFile(bucket: string, path: string, file: UploadableFile, options: { upsert?: boolean } = {}): Promise<void> {
  const upsert = options.upsert ?? false;
  const storage = supabase().storage.from(bucket);

  if (!inReactNative()) {
    const { error } = await storage.upload(path, file.blob, { contentType: file.mimeType, upsert });
    if (error) throw new Error(error.message);
    return;
  }

  const { data, error } = await storage.createSignedUploadUrl(path, { upsert });
  if (error || !data) throw new Error(error?.message ?? "Could not start the upload.");

  const res = await fetch(data.signedUrl, {
    method: "PUT",
    headers: { "content-type": file.mimeType, "cache-control": "max-age=3600", "x-upsert": String(upsert) },
    // The same bytes with the type this app checked, not the one Android guessed from the file's name
    // (it calls a .csv "text/comma-separated-values", which the buckets do not take). A view, not a copy.
    body: file.blob.slice(0, file.blob.size, file.mimeType),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(detail?.message ?? detail?.error ?? `The upload was refused (${res.status}).`);
  }
}

/** True inside a React Native app, whose networking is not a browser's. */
function inReactNative(): boolean {
  return (globalThis as { navigator?: { product?: string } }).navigator?.product === "ReactNative";
}
