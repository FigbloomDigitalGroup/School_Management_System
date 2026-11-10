import { supabase, supabaseApiKey } from "./supabase";

/**
 * Every stored file goes through here: upload, link, delete, download. One module, so moving Schools' files from Supabase
 * Storage to S3 is a setting, not a change in every screen.
 *
 * Where files are is the database's files_service row (supabase/migrations/20261110130000_files_service.sql), read once
 * when the app starts (loadFilesService) and before any file operation: no row, Supabase Storage as before; a row, S3
 * through the files API (figbloom-platform, SchoolsFiles-<env>). Web and phones switch together, with no rebuild.
 * initFiles() sets it directly (tests).
 *
 * Who may do what is the same either way: the database's rules (Supabase Storage's policies, or file_access() behind the
 * files API, which restates them). Paths and bucket names don't change.
 */

export interface FilesConfig {
  /** The files API's address (SchoolsFiles-<env> output FilesApiUrl) */
  apiUrl: string;
  /** Where public-assets are read from (output PublicAssetsUrl) */
  publicBaseUrl: string;
}

let s3: FilesConfig | null = null;
let loading: Promise<void> | null = null;

export function initFiles(cfg: Partial<FilesConfig> | null | undefined): void {
  s3 = cfg?.apiUrl && cfg.publicBaseUrl
    ? { apiUrl: cfg.apiUrl.replace(/\/+$/, ""), publicBaseUrl: cfg.publicBaseUrl.replace(/\/+$/, "") }
    : null;
  loading = Promise.resolve();
}

/**
 * Reads where files are (the files_service row). The apps start it right after initSupabase(), so public file addresses
 * are right from the first screen; every file operation waits for it. A failed read is tried again on the next operation,
 * and that operation fails rather than guess: files put in the wrong place would be invisible to everyone else.
 */
export function loadFilesService(): Promise<void> {
  loading ??= (async () => {
    const { data, error } = await supabase().from("files_service").select("api_url, public_base_url").maybeSingle<{ api_url: string; public_base_url: string }>();
    // no such table yet (the app deployed before its migration): files are where they always were
    if (error && (error.code === "PGRST205" || error.code === "42P01")) { initFiles(null); return; }
    if (error) throw new Error(`Could not find out where files are kept: ${error.message}`);
    initFiles(data ? { apiUrl: data.api_url, publicBaseUrl: data.public_base_url } : null);
  })().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** True when files are on S3 (the files API), false on Supabase Storage. */
export const filesOnS3 = (): boolean => s3 !== null;

export const PUBLIC_ASSETS_BUCKET = "public-assets";

/** Above this, an S3 upload goes in parts: a dropped connection loses one part, not the file. */
export const MULTIPART_THRESHOLD_BYTES = 32 * 1024 ** 2;

export class FilesError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** What the files API's answer means, in words a teacher or parent can act on. */
function messageFor(status: number, detail: string | undefined): string {
  switch (status) {
    case 401: return "You've been signed out. Sign in again and retry.";
    case 403: return "You don't have permission to do that with this file.";
    case 404: return "That file isn't there any more.";
    case 409: return "A file with that name is already there. Try again.";
    case 413: return "That file is bigger than this school's upload limit allows.";
    case 415: return "That type of file can't be uploaded here.";
    default: return detail ? `The file service said: ${detail}` : `The file service failed (${status}). Try again.`;
  }
}

async function callApi<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  if (!s3) throw new Error("initFiles() has not set up the files API");
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new FilesError(401, messageFor(401, undefined));
  const res = await fetch(`${s3.apiUrl}/files/${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, apikey: supabaseApiKey(), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const answer = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new FilesError(res.status, messageFor(res.status, answer?.error));
  return answer as T;
}

interface SignedPut { url: string; method: "PUT"; headers: Record<string, string> }

// ---------------------------------------------------------------- uploading

export interface StoreOptions {
  /** Replace a file already at the path (otherwise that is refused) */
  upsert?: boolean;
  /** 0 to 1, for uploads big enough to go in parts */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Stores `blob` at `path` in `bucket`, as `contentType`. Nothing is overwritten unless `upsert`. On S3 the upload goes
 * from the device straight to S3, on a link signed for exactly this file; big files go in parts.
 */
export async function storeFile(bucket: string, path: string, blob: Blob, contentType: string, options: StoreOptions = {}): Promise<void> {
  await loadFilesService();
  // the same bytes, typed as this app checked them (Android calls a .csv "text/comma-separated-values"). A view, not a copy.
  if (!s3) return storeOnSupabase(bucket, path, blob, contentType, options.upsert ?? false);
  const body = blob.slice(0, blob.size, contentType);
  if (body.size > MULTIPART_THRESHOLD_BYTES) return storeInParts(bucket, path, body, contentType, options);

  let signed: SignedPut;
  try {
    signed = await callApi<SignedPut>("sign", { bucket, path, op: "write", contentType, size: body.size }, options.signal);
  } catch (err) {
    if (!(options.upsert && err instanceof FilesError && err.status === 409)) throw err;
    signed = await callApi<SignedPut>("sign", { bucket, path, op: "replace", contentType, size: body.size }, options.signal);
  }
  options.onProgress?.(0);
  const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body, signal: options.signal });
  if (!res.ok) throw new FilesError(res.status, res.status === 412 ? messageFor(409, undefined) : `The upload was refused (${res.status}).`);
  options.onProgress?.(1);
}

interface Started { uploadId: string; partSize: number; partCount: number }

async function storeInParts(bucket: string, path: string, body: Blob, contentType: string, options: StoreOptions): Promise<void> {
  const target = { bucket, path };
  const { uploadId, partSize, partCount } = await callApi<Started>("multipart/start", { ...target, contentType, size: body.size }, options.signal);
  const done: { partNumber: number; etag: string }[] = [];
  let sent = 0;
  options.onProgress?.(0);
  try {
    for (let first = 1; first <= partCount; first += 100) {
      const numbers = Array.from({ length: Math.min(100, partCount - first + 1) }, (_, i) => first + i);
      // links are asked for a hundred parts at a time, so none expires while earlier parts go up
      const { parts } = await callApi<{ parts: { partNumber: number; url: string }[] }>(
        "multipart/parts", { ...target, uploadId, partNumbers: numbers }, options.signal);
      for (const { partNumber, url } of parts) {
        const chunk = body.slice((partNumber - 1) * partSize, partNumber * partSize);
        done.push({ partNumber, etag: await putPart(url, chunk, options.signal) });
        sent += chunk.size;
        options.onProgress?.(sent / body.size);
      }
    }
    await callApi("multipart/complete", { ...target, uploadId, parts: done }, options.signal);
  } catch (err) {
    // best effort: S3 also clears an unfinished upload after two days
    await callApi("multipart/abort", { ...target, uploadId }).catch(() => {});
    throw err;
  }
}

/** One part, tried three times: school Wi-Fi drops. Gives the part's ETag. */
async function putPart(url: string, chunk: Blob, signal?: AbortSignal): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body: chunk, signal });
      const etag = res.headers.get("etag");
      if (res.ok && etag) return etag;
      last = new FilesError(res.status, `A part of the upload was refused (${res.status}).`);
      if (res.status < 500) break;
    } catch (err) {
      if (signal?.aborted) throw err;
      last = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw last instanceof Error ? last : new Error("The upload failed. Try again.");
}

/**
 * Supabase Storage, as before. In a browser, the storage client's own upload. In React Native the client's FormData
 * upload can't send a Blob, so the file goes as a PUT body to a signed upload URL (issued only if the user may upload it).
 */
async function storeOnSupabase(bucket: string, path: string, blob: Blob, contentType: string, upsert: boolean): Promise<void> {
  const storage = supabase().storage.from(bucket);
  if (!inReactNative()) {
    const { error } = await storage.upload(path, blob, { contentType, upsert });
    if (error) throw new Error(error.message);
    return;
  }
  const { data, error } = await storage.createSignedUploadUrl(path, { upsert });
  if (error || !data) throw new Error(error?.message ?? "Could not start the upload.");
  const res = await fetch(data.signedUrl, {
    method: "PUT",
    headers: { "content-type": contentType, "cache-control": "max-age=3600", "x-upsert": String(upsert) },
    body: blob.slice(0, blob.size, contentType),
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

// ---------------------------------------------------------------- reading

/**
 * A time-limited link to one private file. `download` names the file the browser saves (true: its own name). Links last
 * `seconds` (at most an hour), long enough for a lesson video to keep loading while it plays.
 */
export async function fileLink(bucket: string, path: string, seconds = 3600, download?: string | boolean): Promise<string> {
  await loadFilesService();
  if (bucket === PUBLIC_ASSETS_BUCKET) return publicFileUrl(path);
  if (s3) {
    const downloadName = download === true ? path.split("/").pop() : download || undefined;
    const { url } = await callApi<{ url: string }>("sign", { bucket, path, op: "read", expiresIn: Math.min(seconds, 3600), downloadName });
    return url;
  }
  const { data, error } = await supabase().storage.from(bucket).createSignedUrl(path, seconds, download ? { download } : undefined);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

/**
 * The address of a public file (a school's crest, an avatar). Anyone with it can see the file, as before. Synchronous, so
 * it uses what loadFilesService() has found so far (the apps start it with the client).
 */
export function publicFileUrl(path: string): string {
  if (s3) return `${s3.publicBaseUrl}/${path.split("/").map(encodeURIComponent).join("/")}`;
  return supabase().storage.from(PUBLIC_ASSETS_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** The file's bytes (to hash a document before signing it, say). */
export async function downloadFile(bucket: string, path: string): Promise<Blob> {
  await loadFilesService();
  if (s3) {
    const res = await fetch(await fileLink(bucket, path, 600));
    if (!res.ok) throw new FilesError(res.status, messageFor(res.status, undefined));
    return res.blob();
  }
  const { data, error } = await supabase().storage.from(bucket).download(path);
  if (error || !data) throw new Error(error?.message ?? "Could not read the file.");
  return data;
}

// ---------------------------------------------------------------- deleting

/**
 * Deletes files. As on Supabase Storage, a file the user may not delete is left alone without an error (the rules
 * decide, e.g. payment proofs are kept); only a failure of the service itself throws.
 */
export async function deleteFiles(bucket: string, paths: (string | null | undefined)[]): Promise<void> {
  const list = paths.filter((p): p is string => !!p);
  if (!list.length) return;
  await loadFilesService();
  if (s3) {
    for (let i = 0; i < list.length; i += 100) await callApi("delete", { bucket, paths: list.slice(i, i + 100) });
    return;
  }
  const { error } = await supabase().storage.from(bucket).remove(list);
  if (error) throw new Error(error.message);
}
