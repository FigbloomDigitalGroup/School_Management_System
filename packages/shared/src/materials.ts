import { supabase } from "./supabase";

/**
 * Learning materials, and files or links on announcements and homework
 * (supabase/migrations/20261026020000_learning_materials.sql).
 *
 * A teacher shares a document, video, picture, recording or link with one
 * class for one subject; learners and their parents see it once it's
 * published. The same shape (an uploaded file, or an https link) hangs off
 * an announcement or a piece of homework as an attachment.
 *
 * Files live in the private `learning-media` bucket and are opened through
 * short-lived signed URLs. Uploading is web-only (apps/web/src/lib/uploads.ts,
 * resumable for big videos); both mobile apps only list and open.
 */

export type MaterialKind = "document" | "video" | "image" | "audio" | "link";

export const MATERIAL_KIND_LABEL: Record<MaterialKind, string> = {
  document: "Document",
  video: "Video",
  image: "Picture",
  audio: "Recording",
  link: "Link",
};

export const LEARNING_MEDIA_BUCKET = "learning-media";

/** Mirrors the bucket's file_size_limit (2 GB). The hosted project's own upload limit has to allow it too. */
export const MAX_FILE_BYTES = 2 * 1024 ** 3;

/** Bigger than this goes up in resumable 6 MB chunks (Supabase's TUS endpoint) so a dropped connection doesn't start over. */
export const RESUMABLE_THRESHOLD_BYTES = 6 * 1024 ** 2;

const TITLE_MAX = 160;
const DESCRIPTION_MAX = 4000;
const URL_MAX = 2000;

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

// ---------------------------------------------------------------- files
/** The file types the bucket accepts (allowed_mime_types in the migration), by extension. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  zip: "application/zip",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  "3gp": "video/3gpp",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
};

/** Types browsers report that the bucket also takes, beyond the ones above. */
const OTHER_ALLOWED = new Set(["application/x-zip-compressed", "audio/x-m4a", "audio/x-wav", "audio/webm"]);
const ALLOWED_MIME = new Set([...Object.values(MIME_BY_EXT), ...OTHER_ALLOWED]);

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * The type to upload a file as. The browser's own guess wins when the bucket
 * accepts it; otherwise the extension decides (Windows often reports "" for
 * .mkv, or application/octet-stream for a .docx from a phone). Null when
 * it's a kind of file the bucket won't take.
 */
export function mimeForFile(file: { name: string; type?: string | null }): string | null {
  const reported = (file.type ?? "").toLowerCase();
  if (ALLOWED_MIME.has(reported)) return reported;
  return MIME_BY_EXT[extOf(file.name)] ?? null;
}

/** What a file is, from its type: drives the icon, and whether it plays inline. */
export function kindForMime(mime: string): MaterialKind {
  const m = mime.toLowerCase();
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("image/")) return "image";
  return "document";
}

/**
 * Why this file can't be uploaded, or null if it can. `maxBytes` is the
 * hosted project's own upload limit when that is lower than the bucket's
 * (the web app passes VITE_MAX_UPLOAD_MB), so a file that would be refused
 * is caught before any of it is sent.
 */
export function fileProblem(
  file: { name: string; size: number; type?: string | null }, maxBytes: number = MAX_FILE_BYTES,
): string | null {
  const limit = Math.min(maxBytes, MAX_FILE_BYTES);
  if (file.size <= 0) return `"${file.name}" is empty.`;
  if (file.size > limit) return `"${file.name}" is ${formatFileSize(file.size)}. Files can be up to ${formatFileSize(limit)}. For a longer video, upload it to YouTube or Google Drive and paste the link instead.`;
  if (!mimeForFile(file)) {
    return `"${file.name}" isn't a type we can share. Use a PDF, Word, Excel or PowerPoint file, a picture, a video (MP4, WebM, MOV) or a recording (MP3, M4A).`;
  }
  return null;
}

/** "512 bytes", "820 KB", "4.2 MB", "1.3 GB". */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** A file name safe to put in a storage path: no slashes, nothing exotic. */
export function safeFileName(name: string): string {
  const cleaned = name.trim().replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").slice(-120);
  return cleaned || "file";
}

export type AttachmentOwner = "announcement" | "homework";

const OWNER_FOLDER: Record<AttachmentOwner, string> = { announcement: "announcements", homework: "homework" };

/**
 * A random version-4 id, for a material whose row and file path are made
 * before the database has seen it (the file lives under the material's own
 * id). Math.random rather than crypto.randomUUID(): a phone has no
 * crypto.randomUUID. It only has to be unique, not secret. `random` is a
 * parameter so a test can fix it.
 */
export function newMaterialId(random: () => number = Math.random): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(random() * 16);
    return (c === "x" ? n : (n & 0x3) | 0x8).toString(16);
  });
}

/** Where a material's file lives. The database checks it's under the material's own folder. */
export function materialFilePath(tenantId: string, materialId: string, fileName: string): string {
  return `${tenantId}/materials/${materialId}/${Date.now()}-${safeFileName(fileName)}`;
}

/** Where an announcement's or homework's file lives. */
export function attachmentFilePath(tenantId: string, owner: AttachmentOwner, ownerId: string, fileName: string): string {
  return `${tenantId}/${OWNER_FOLDER[owner]}/${ownerId}/${Date.now()}-${safeFileName(fileName)}`;
}

// ---------------------------------------------------------------- links
/** Mirrors the database's check: https, a real-looking host, no spaces. */
export function isHttpsUrl(url: string): boolean {
  return url.length <= URL_MAX && /^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/i.test(url);
}

/**
 * What a teacher pasted, made into a link we'll save. "www.youtube.com/..."
 * without the scheme is filled in and plain http is upgraded, the same as
 * class meeting links (normaliseMeetingUrl).
 */
export function validateLink(input: string): Checked<string> {
  let url = input.trim();
  if (!url) return { ok: false, message: "Paste the link." };
  if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
  if (url.length > URL_MAX) return { ok: false, message: "That link is too long." };
  if (!isHttpsUrl(url)) return { ok: false, message: "That doesn't look like a web link. Copy it from the address bar, starting https://" };
  return { ok: true, value: url };
}

export type EmbedProvider = "youtube" | "vimeo" | "drive" | "google_docs";

export interface Embed {
  provider: EmbedProvider;
  /** The URL to put in an <iframe>. */
  embedUrl: string;
  /** YouTube and Vimeo are always video; a Drive file may be a video, a PDF or anything else. */
  isVideo: boolean;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** "1m30s", "90", "90s" -> 90 (YouTube's t= parameter). */
function youtubeSeconds(t: string | null): number | null {
  if (!t) return null;
  if (/^\d+s?$/.test(t)) return parseInt(t, 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * The embeddable form of a YouTube, Vimeo or Google Drive / Docs link, or
 * null for anything else (which then just opens in a new tab). Only these
 * hosts are ever put in an iframe.
 */
export function parseEmbed(url: string): Embed | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  const parts = u.pathname.split("/").filter(Boolean);

  // YouTube: watch?v=, youtu.be/, shorts/, embed/, live/
  if (host === "youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be") {
    let id: string | null = null;
    if (host === "youtu.be") id = parts[0] ?? null;
    else if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live" || parts[0] === "v") id = parts[1] ?? null;
    if (!id || !YT_ID.test(id)) return null;
    const start = youtubeSeconds(u.searchParams.get("t") ?? u.searchParams.get("start"));
    return {
      provider: "youtube",
      // rel=0: the videos suggested at the end come from the same channel, not anywhere on YouTube
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0${start ? `&start=${start}` : ""}`,
      isVideo: true,
    };
  }

  // Vimeo: vimeo.com/123456, vimeo.com/123456/abcdef (unlisted), player.vimeo.com/video/123456?h=abcdef
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const at = host === "player.vimeo.com" ? (parts[0] === "video" ? 1 : -1) : parts.findIndex((p) => /^\d+$/.test(p));
    const id = at >= 0 ? parts[at] : undefined;
    if (!id || !/^\d+$/.test(id)) return null;
    const hash = u.searchParams.get("h") ?? (host === "vimeo.com" && /^[a-f0-9]{6,}$/i.test(parts[at + 1] ?? "") ? parts[at + 1]! : null);
    return { provider: "vimeo", embedUrl: `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`, isVideo: true };
  }

  // Google Drive: /file/d/ID/view (or /edit, /preview), /open?id=ID, uc?id=ID
  if (host === "drive.google.com") {
    let id: string | null = null;
    if (parts[0] === "file" && parts[1] === "d") id = parts[2] ?? null;
    else if (parts[0] === "open" || parts[0] === "uc") id = u.searchParams.get("id");
    if (!id || !/^[\w-]{10,}$/.test(id)) return null;
    return { provider: "drive", embedUrl: `https://drive.google.com/file/d/${id}/preview`, isVideo: false };
  }

  // Google Docs, Slides, Sheets: /document/d/ID/edit -> /preview
  if (host === "docs.google.com") {
    const type = parts[0];
    if ((type === "document" || type === "presentation" || type === "spreadsheets") && parts[1] === "d" && parts[2] && /^[\w-]{10,}$/.test(parts[2])) {
      return { provider: "google_docs", embedUrl: `https://docs.google.com/${type}/d/${parts[2]}/preview`, isVideo: false };
    }
  }
  return null;
}

/** What a pasted link is: a video if it's YouTube or Vimeo, otherwise just a link. */
export function kindForLink(url: string): MaterialKind {
  return parseEmbed(url)?.isVideo ? "video" : "link";
}

/** A title for a link when the teacher didn't give one: "YouTube video", "Google Drive file", or the site's name. */
export function defaultLinkTitle(url: string): string {
  const e = parseEmbed(url);
  if (e?.provider === "youtube") return "YouTube video";
  if (e?.provider === "vimeo") return "Vimeo video";
  if (e?.provider === "drive") return "Google Drive file";
  if (e?.provider === "google_docs") return "Google document";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
}

// ---------------------------------------------------------------- the material form
export interface MaterialInput {
  classId: string;
  subjectId: string;
  title: string;
  description: string;
}

export function validateMaterial(input: MaterialInput): Checked<MaterialInput> {
  const title = input.title.trim().replace(/\s+/g, " ");
  const description = input.description.trim();
  if (!input.classId) return { ok: false, message: "Pick the class." };
  if (!input.subjectId) return { ok: false, message: "Pick the subject." };
  if (!title) return { ok: false, message: "Give it a title, e.g. Photosynthesis: notes and diagrams." };
  if (title.length > TITLE_MAX) return { ok: false, message: `Keep the title to ${TITLE_MAX} characters or fewer.` };
  if (description.length > DESCRIPTION_MAX) return { ok: false, message: `Keep the description to ${DESCRIPTION_MAX} characters or fewer.` };
  return { ok: true, value: { ...input, title, description } };
}

/** A file picked or a link pasted, before it's saved anywhere. */
export type MediaDraft =
  | { type: "file"; file: { name: string; size: number; type?: string | null }; title: string }
  | { type: "link"; url: string; title: string };

/** Title for a draft: what the teacher typed, else the file name or the link's site. */
export function draftTitle(d: MediaDraft): string {
  const typed = d.title.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX);
  if (typed) return typed;
  if (d.type === "file") return d.file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, TITLE_MAX) || "File";
  return defaultLinkTitle(d.url).slice(0, TITLE_MAX);
}

// ---------------------------------------------------------------- shared row shape
/** What a material and an attachment have in common: one file, or one link. */
export interface MediaItem {
  id: string;
  kind: MaterialKind;
  title: string;
  filePath: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string | null;
}

interface MediaDbRow {
  id: string; kind: MaterialKind; title: string;
  file_path: string | null; file_name: string | null; mime_type: string | null; size_bytes: number | null; url: string | null;
}

const toMedia = (r: MediaDbRow): MediaItem => ({
  id: r.id, kind: r.kind, title: r.title,
  filePath: r.file_path, fileName: r.file_name, mimeType: r.mime_type, sizeBytes: r.size_bytes, url: r.url,
});

/** "Video · 120 MB", "Link · youtube.com". */
export function mediaSummary(m: MediaItem): string {
  if (m.filePath) return [MATERIAL_KIND_LABEL[m.kind], formatFileSize(m.sizeBytes)].filter(Boolean).join(" · ");
  const embed = m.url ? parseEmbed(m.url) : null;
  if (embed?.provider === "youtube") return "YouTube video";
  if (embed?.provider === "vimeo") return "Vimeo video";
  if (embed?.provider === "drive") return "Google Drive";
  if (embed?.provider === "google_docs") return "Google Docs";
  try {
    return `Link · ${new URL(m.url ?? "").hostname.replace(/^www\./, "")}`;
  } catch {
    return "Link";
  }
}

/** A signed, time-limited URL for a file in learning-media. Works on web and both apps. */
export async function mediaUrl(path: string, expiresInSeconds = 3600, download?: string): Promise<string> {
  const { data, error } = await supabase().storage
    .from(LEARNING_MEDIA_BUCKET)
    .createSignedUrl(path, expiresInSeconds, download ? { download } : undefined);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

/** Where to send someone who taps an item: a signed file URL, or the link itself. */
export async function openableUrl(m: Pick<MediaItem, "filePath" | "url">): Promise<string> {
  if (m.filePath) return mediaUrl(m.filePath);
  if (m.url) return m.url;
  throw new Error("Nothing to open.");
}

/** Removes files from learning-media. Best-effort callers catch; a file left behind is tidied by the office. */
export async function removeMediaFiles(paths: (string | null | undefined)[]): Promise<void> {
  const list = paths.filter((p): p is string => !!p);
  if (!list.length) return;
  const { error } = await supabase().storage.from(LEARNING_MEDIA_BUCKET).remove(list);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- data: materials
export interface MaterialRow extends MediaItem {
  classId: string;
  className: string;
  subjectId: string;
  subjectName: string;
  description: string;
  publishedAt: string | null;
  createdAt: string;
}

interface MaterialDbRow extends MediaDbRow {
  class_id: string; subject_id: string; description: string; published_at: string | null; created_at: string;
  classes: { name: string } | null; subjects: { name: string } | null;
}

const MATERIAL_COLS = "id, kind, title, description, class_id, subject_id, file_path, file_name, mime_type, size_bytes, url, published_at, created_at, classes(name), subjects(name)";

const toMaterial = (r: MaterialDbRow): MaterialRow => ({
  ...toMedia(r),
  classId: r.class_id, className: r.classes?.name ?? "—",
  subjectId: r.subject_id, subjectName: r.subjects?.name ?? "—",
  description: r.description, publishedAt: r.published_at, createdAt: r.created_at,
});

/** Every material in the school, newest first. Staff read them all; a teacher's screen narrows this to what they teach. */
export async function fetchMaterials(tenantId: string): Promise<MaterialRow[]> {
  const { data, error } = await supabase()
    .from("learning_materials")
    .select(MATERIAL_COLS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .returns<MaterialDbRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toMaterial);
}

/** A class's published materials, for a learner or their parent. RLS hides drafts. */
export async function fetchClassMaterials(classId: string): Promise<MaterialRow[]> {
  const { data, error } = await supabase()
    .from("learning_materials")
    .select(MATERIAL_COLS)
    .eq("class_id", classId)
    .not("published_at", "is", null)
    .order("published_at", { ascending: false })
    .returns<MaterialDbRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toMaterial);
}

/** Materials by subject, subjects A to Z, newest first within each. */
export function groupBySubject<T extends { subjectName: string }>(items: T[]): { subject: string; items: T[] }[] {
  const by = new Map<string, T[]>();
  for (const it of items) by.set(it.subjectName, [...(by.get(it.subjectName) ?? []), it]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([subject, list]) => ({ subject, items: list }));
}

/** A change row-level security filters out is "0 rows", not an error; say so rather than report success. */
const NOT_YOURS = "You can only change materials for a class and subject you teach.";

/**
 * Saves a new material as a draft and returns its id. A file's row goes in
 * before the file itself (the storage policy only lets a file up under a
 * material that exists), so the caller uploads to `filePath` next and calls
 * deleteMaterial if that fails.
 */
export async function createMaterial(
  tenantId: string,
  input: MaterialInput,
  media: { kind: MaterialKind; url: string } | { kind: MaterialKind; id: string; filePath: string; fileName: string; mimeType: string; sizeBytes: number },
): Promise<string> {
  const row = "url" in media
    ? { kind: media.kind, url: media.url }
    : { id: media.id, kind: media.kind, file_path: media.filePath, file_name: media.fileName, mime_type: media.mimeType, size_bytes: media.sizeBytes };
  const { data, error } = await supabase()
    .from("learning_materials")
    .insert({ tenant_id: tenantId, class_id: input.classId, subject_id: input.subjectId, title: input.title, description: input.description, ...row })
    .select("id")
    .single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function updateMaterial(id: string, input: MaterialInput): Promise<void> {
  const { data, error } = await supabase()
    .from("learning_materials")
    .update({ class_id: input.classId, subject_id: input.subjectId, title: input.title, description: input.description })
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

export async function setMaterialPublished(id: string, published: boolean): Promise<void> {
  const { data, error } = await supabase()
    .from("learning_materials")
    .update({ published_at: published ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

/** Removes the file first (the storage policy reads the row), then the row. */
export async function deleteMaterial(m: Pick<MaterialRow, "id" | "filePath">): Promise<void> {
  await removeMediaFiles([m.filePath]);
  const { data, error } = await supabase().from("learning_materials").delete().eq("id", m.id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(NOT_YOURS);
}

// ---------------------------------------------------------------- data: attachments
const OWNER_COLUMN: Record<AttachmentOwner, "announcement_id" | "assignment_id"> = {
  announcement: "announcement_id",
  homework: "assignment_id",
};

/** Attachments for several announcements or homework at once, keyed by owner id, oldest first. */
export async function fetchAttachments(owner: AttachmentOwner, ownerIds: string[]): Promise<Map<string, MediaItem[]>> {
  const out = new Map<string, MediaItem[]>();
  const ids = [...new Set(ownerIds)];
  if (!ids.length) return out;
  const col = OWNER_COLUMN[owner];
  const { data, error } = await supabase()
    .from("attachments")
    .select(`id, kind, title, file_path, file_name, mime_type, size_bytes, url, ${col}`)
    .in(col, ids)
    .order("created_at")
    .returns<(MediaDbRow & Record<string, string>)[]>();
  if (error) throw new Error(error.message);
  for (const r of data ?? []) {
    const key = r[col]!;
    out.set(key, [...(out.get(key) ?? []), toMedia(r)]);
  }
  return out;
}

/** Records a link, or a file already uploaded to attachmentFilePath(). */
export async function addAttachment(
  owner: AttachmentOwner,
  ownerId: string,
  item: { kind: MaterialKind; title: string; url: string } | { kind: MaterialKind; title: string; filePath: string; fileName: string; mimeType: string; sizeBytes: number },
): Promise<void> {
  const media = "url" in item
    ? { url: item.url }
    : { file_path: item.filePath, file_name: item.fileName, mime_type: item.mimeType, size_bytes: item.sizeBytes };
  // tenant_id is filled in from the owner by a trigger (attachments_consistent).
  const { error } = await supabase().from("attachments").insert({
    [OWNER_COLUMN[owner]]: ownerId,
    kind: item.kind,
    title: item.title,
    ...media,
  });
  if (error) throw new Error(error.message);
}

/** Removes one attachment and its file. */
export async function removeAttachment(a: Pick<MediaItem, "id" | "filePath">): Promise<void> {
  await removeMediaFiles([a.filePath]);
  const { data, error } = await supabase().from("attachments").delete().eq("id", a.id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("You can only remove files from your own homework or messages.");
}

/**
 * Before deleting an announcement or homework: removes its attachments'
 * files, which the row's cascade would otherwise leave behind in storage.
 */
export async function removeAttachmentFilesFor(owner: AttachmentOwner, ownerId: string): Promise<void> {
  const list = (await fetchAttachments(owner, [ownerId])).get(ownerId) ?? [];
  await removeMediaFiles(list.map((a) => a.filePath));
}

/**
 * Publishes an announcement that was saved as a draft so its files could go
 * up first: families get the notice and its attachments at the same moment.
 */
export async function publishAnnouncement(id: string): Promise<void> {
  const { data, error } = await supabase().from("announcements").update({ published_at: new Date().toISOString() }).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("That announcement could not be published.");
}
