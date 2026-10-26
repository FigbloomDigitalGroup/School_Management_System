import { Upload, type DetailedError } from "tus-js-client";
import {
  LEARNING_MEDIA_BUCKET, RESUMABLE_THRESHOLD_BYTES, addAttachment, attachmentFilePath, draftTitle, kindForLink, kindForMime,
  mimeForFile, removeMediaFiles, supabase, type AttachmentOwner, type MediaDraft,
} from "@figbloom/shared";

/**
 * Uploads to the learning-media bucket (supabase/migrations/20261026020000_learning_materials.sql).
 *
 * Anything over 6 MB goes through Supabase's resumable (TUS) endpoint in 6 MB
 * chunks: a lesson video can be hundreds of MB on school Wi-Fi, and a dropped
 * connection picks up where it left off instead of starting again. Smaller
 * files take the ordinary single request.
 *
 * The hosted project's global upload limit (Dashboard -> Storage -> Settings)
 * caps both, whatever the bucket allows.
 */

export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled.");
  }
}

export interface UploadHandle {
  /** Resolves when the file is stored; rejects with UploadCancelled after cancel(). */
  done: Promise<void>;
  cancel: () => void;
}

/** Supabase's TUS server only takes 6 MB chunks. */
const CHUNK_BYTES = 6 * 1024 * 1024;

async function accessToken(): Promise<string> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("You've been signed out. Sign in again and retry.");
  return token;
}

/** What the TUS server said, in words a teacher can act on. */
function tusMessage(err: Error): string {
  const res = (err as DetailedError).originalResponse;
  const status = res?.getStatus();
  const body = res?.getBody() ?? "";
  if (status === 413 || /too large|maximum size|exceeded/i.test(body)) {
    return "That file is bigger than this school's upload limit allows.";
  }
  if (status === 415 || /mime type/i.test(body)) return "That type of file can't be uploaded here.";
  if (status === 401 || status === 403) return "You don't have permission to upload this here.";
  if (status === 409) return "A file with that name is already there. Try again.";
  return body ? `Upload failed: ${body.slice(0, 200)}` : `Upload failed: ${err.message}`;
}

/**
 * Starts uploading one file to `path` in learning-media. `onProgress` gets
 * 0 to 1. Nothing is overwritten: paths carry a timestamp.
 */
export function uploadLearningMedia(path: string, file: File, contentType: string, onProgress: (fraction: number) => void): UploadHandle {
  if (file.size <= RESUMABLE_THRESHOLD_BYTES) {
    // The ordinary upload has no progress events and can't be aborted; a
    // cancel that arrives while it's in flight removes the file afterwards.
    let cancelled = false;
    const done = (async () => {
      onProgress(0);
      const { error } = await supabase().storage.from(LEARNING_MEDIA_BUCKET).upload(path, file, { contentType, upsert: false });
      if (error) throw new Error(error.message);
      if (cancelled) {
        await removeMediaFiles([path]).catch(() => {});
        throw new UploadCancelled();
      }
      onProgress(1);
    })();
    return { done, cancel: () => { cancelled = true; } };
  }

  let upload: Upload | null = null;
  let rejectDone: (e: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    rejectDone = reject;
    upload = new Upload(file, {
      endpoint: `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      chunkSize: CHUNK_BYTES,
      uploadDataDuringCreation: true,
      // Resuming happens within this upload (a dropped connection retries
      // from the last chunk). Nothing is kept for a later visit: every
      // upload goes to a new path, and tus would otherwise match a past
      // upload of the same file and finish it at the old path.
      storeFingerprintForResuming: false,
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, "x-upsert": "false" },
      metadata: { bucketName: LEARNING_MEDIA_BUCKET, objectName: path, contentType, cacheControl: "3600" },
      // A big video can outlast the hour a sign-in token lasts: fetch the current one for every chunk.
      onBeforeRequest: async (req) => {
        req.setHeader("Authorization", `Bearer ${await accessToken()}`);
      },
      onProgress: (sent, total) => onProgress(total ? sent / total : 0),
      onError: (err) => reject(new Error(tusMessage(err))),
      onSuccess: () => { onProgress(1); resolve(); },
    });
    upload.start();
  });
  return {
    done,
    cancel: () => {
      // true: tell the server to throw away what it has so far.
      void (upload as Upload | null)?.abort(true).catch(() => {});
      rejectDone(new UploadCancelled());
    },
  };
}

/** A file or link picked in the form, with the browser File it came from. */
export type WebMediaDraft = (Extract<MediaDraft, { type: "file" }> & { file: File }) | Extract<MediaDraft, { type: "link" }>;

export interface BatchProgress {
  /** 1-based index of the item being saved. */
  index: number;
  total: number;
  name: string;
  /** 0 to 1, for the current file. */
  fraction: number;
}

export interface AttachmentBatch {
  done: Promise<void>;
  cancel: () => void;
}

/**
 * Saves a form's new attachments to an announcement or homework one after
 * another: links straight in, files uploaded first. Stops at the first
 * failure or a cancel; everything already saved stays, and the caller says
 * what didn't make it.
 */
export function saveAttachments(
  tenantId: string,
  owner: AttachmentOwner,
  ownerId: string,
  drafts: WebMediaDraft[],
  onProgress: (p: BatchProgress) => void,
  /** Called as each one is saved, so a retry after a failure doesn't add it twice. */
  onItemSaved: (draft: WebMediaDraft) => void = () => {},
): AttachmentBatch {
  let current: UploadHandle | null = null;
  let cancelled = false;
  const done = (async () => {
    for (const [i, d] of drafts.entries()) {
      if (cancelled) throw new UploadCancelled();
      const title = draftTitle(d);
      const report = (fraction: number) => onProgress({ index: i + 1, total: drafts.length, name: title, fraction });
      report(0);
      if (d.type === "link") {
        await addAttachment(owner, ownerId, { kind: kindForLink(d.url), title, url: d.url });
        report(1);
        onItemSaved(d);
        continue;
      }
      const mime = mimeForFile(d.file);
      if (!mime) throw new Error(`"${d.file.name}" isn't a type of file we can share.`);
      const path = attachmentFilePath(tenantId, owner, ownerId, d.file.name);
      current = uploadLearningMedia(path, d.file, mime, report);
      await current.done;
      current = null;
      try {
        await addAttachment(owner, ownerId, { kind: kindForMime(mime), title, filePath: path, fileName: d.file.name, mimeType: mime, sizeBytes: d.file.size });
      } catch (err) {
        await removeMediaFiles([path]).catch(() => {});
        throw err;
      }
      onItemSaved(d);
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      current?.cancel();
    },
  };
}

/** "Uploading 2 of 3: Cells video (45%)". */
export function batchProgressLabel(p: BatchProgress | null): string {
  if (!p) return "";
  const pct = Math.round(p.fraction * 100);
  return `${p.total > 1 ? `Saving ${p.index} of ${p.total}: ` : "Saving "}${p.name} (${pct}%)`;
}
