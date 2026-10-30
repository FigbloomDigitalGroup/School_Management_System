/**
 * Google Drive, Docs and Sheets for Bloom chat: saving an answer, a chat or a
 * table to the person's own Drive, and attaching a file from it to a
 * question. Off unless all three VITE_GOOGLE_* settings are present
 * (.env.example); without them driveConfig() is null, every Drive action is
 * hidden and nothing here loads.
 *
 * Sign-in is Google Identity Services' token model in the browser, for the
 * `drive.file` scope only: the app sees only files the person picks in
 * Google's Picker or creates from Bloom, nothing else in their Drive. The
 * access token lasts an hour and lives in this module's memory; there is no
 * refresh token, no client secret, and nothing about the Google account is
 * stored anywhere by Figbloom. "Disconnect" revokes it.
 *
 * Google's two scripts (accounts.google.com/gsi/client for sign-in,
 * apis.google.com/js/api.js for the Picker) load the first time a Drive
 * action is used, never before.
 */
import {
  attachmentName, chatAttachmentKind, checkChatAttachment, CHAT_MAX_ATTACHMENTS, type ChatAttachment,
} from "../../../../packages/shared/src/bloomAttachments";
import {
  DRIVE_FILE_SCOPE, DRIVE_MULTIPART_MAX_BYTES, driveMultipart, drivePickedFetch, driveUploadMetadata, pickedAttachmentName, PICKER_MIME_TYPES,
  UPLOAD_SOURCE_TYPE, type DriveTarget,
} from "../../../../packages/shared/src/googleDrive";

export interface DriveConfig {
  /** OAuth client ID (type Web application). */
  clientId: string;
  /** Browser API key restricted to the Picker API and this site. */
  apiKey: string;
  /** The Google Cloud project number, which the Picker calls the app ID. */
  appId: string;
}

/** The Drive settings, or null when any is missing: then Bloom shows no Drive actions at all. */
export function driveConfig(): DriveConfig | null {
  const clientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const apiKey = import.meta.env.VITE_GOOGLE_PICKER_API_KEY?.trim();
  const appId = import.meta.env.VITE_GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
  return clientId && apiKey && appId ? { clientId, apiKey, appId } : null;
}

// ------------------------------------------------------------------ Google's scripts, typed as far as used here

const GSI_SCRIPT = "https://accounts.google.com/gsi/client";
const PICKER_SCRIPT = "https://apis.google.com/js/api.js";

interface TokenResponse { access_token?: string; expires_in?: number | string; error?: string; error_description?: string }
interface TokenClient { requestAccessToken(opts?: { prompt?: string }): void }
interface PickerDoc { [key: string]: unknown }
interface PickerData { [key: string]: unknown }
/* The Picker's builder API: each setter returns the builder. */
interface Chain { [method: string]: (...args: unknown[]) => Chain }

interface GoogleNamespace {
  accounts: {
    oauth2: {
      initTokenClient(cfg: {
        client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type?: string }) => void;
      }): TokenClient;
      hasGrantedAllScopes(r: TokenResponse, ...scopes: string[]): boolean;
      revoke(token: string, done?: () => void): void;
    };
  };
  picker: {
    DocsView: new (viewId: unknown) => Chain;
    PickerBuilder: new () => Chain;
    ViewId: { DOCS: unknown };
    Feature: { MULTISELECT_ENABLED: unknown };
    Action: { PICKED: string; CANCEL: string };
    Response: { ACTION: string; DOCUMENTS: string };
    Document: { ID: string; NAME: string; MIME_TYPE: string; SIZE_BYTES: string };
  };
}

type GoogleWindow = { google?: GoogleNamespace; gapi?: { load(name: string, cb: { callback: () => void; onerror: () => void }): void } };
const win = () => window as unknown as GoogleWindow;

const scripts = new Map<string, Promise<void>>();

/** Adds one of Google's scripts to the page, once. */
function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scripts.delete(src); s.remove(); reject(new Error("Google Drive couldn't load. Check your connection and try again.")); };
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

// ------------------------------------------------------------------ signing in

let token: { value: string; expires: number } | null = null;

/** Whether this page holds a Google token that hasn't run out. */
export const driveConnected = () => !!token && token.expires > Date.now();

/**
 * A Drive access token, asking Google for one (a popup) when there's none or
 * it has run out. Call it straight from a click, before any slow work, so the
 * browser lets the popup open.
 */
export async function driveToken(cfg: DriveConfig): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  await loadScript(GSI_SCRIPT);
  const oauth = win().google?.accounts.oauth2;
  if (!oauth) throw new Error("Google sign-in didn't load. Try again.");
  return new Promise<string>((resolve, reject) => {
    const client = oauth.initTokenClient({
      client_id: cfg.clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) return reject(new Error(r.error === "access_denied" ? "Google Drive wasn't connected." : "Google sign-in didn't finish. Try again."));
        if (!oauth.hasGrantedAllScopes(r, DRIVE_FILE_SCOPE)) return reject(new Error("Bloom needs permission for the files you pick or create here. Try again and allow it."));
        token = { value: r.access_token, expires: Date.now() + Number(r.expires_in ?? 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(
        e.type === "popup_failed_to_open" ? "Your browser blocked Google's sign-in window. Allow pop-ups for this site and try again."
        : e.type === "popup_closed" ? "Google sign-in was closed before it finished."
        : "Google sign-in didn't finish. Try again.",
      )),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

/**
 * Who is connected, from Drive's own about.get (allowed under drive.file; no
 * openid, email or profile scope is ever asked for): the address, else the
 * display name, else null when Drive won't say (the header then just says
 * "Google Drive connected").
 */
export async function driveAccount(cfg: DriveConfig): Promise<{ email: string | null; name: string | null }> {
  try {
    const res = await driveFetch(cfg, "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)");
    const body = await res.json() as { user?: { displayName?: string; emailAddress?: string } };
    return { email: body.user?.emailAddress || null, name: body.user?.displayName || null };
  } catch {
    return { email: null, name: null };
  }
}

/** Revokes the token with Google and forgets it. */
export function disconnectDrive(): void {
  const t = token?.value;
  token = null;
  if (t) win().google?.accounts.oauth2.revoke(t);
}

/** A Drive API call with the token; a token Google no longer accepts is dropped so the next action asks again. */
async function driveFetch(cfg: DriveConfig, url: string, init: RequestInit = {}): Promise<Response> {
  const t = await driveToken(cfg);
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${t}` } });
  if (res.status === 401) {
    token = null;
    throw new Error("Your Google sign-in has run out. Try again.");
  }
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ""; } catch { /* not JSON */ }
    throw new Error(`Google Drive said no${detail ? `: ${detail}` : ` (${res.status})`}.`);
  }
  return res;
}

// ------------------------------------------------------------------ saving out

/**
 * Saves a Bloom file to the person's Drive: Word converted to a Google Doc,
 * Excel to a Google Sheet, a PDF as it is, named as the download would be.
 * The token comes first (the popup needs the click), then the file is made.
 */
export async function saveToDrive(
  cfg: DriveConfig, target: DriveTarget, make: () => Promise<{ blob: Blob; fileName: string }>,
): Promise<{ name: string; link: string }> {
  await driveToken(cfg);
  const file = await make();
  if (file.blob.size > DRIVE_MULTIPART_MAX_BYTES) throw new Error("That file is too big to save to Drive from here. Download it instead.");
  const parts = driveMultipart(driveUploadMetadata(file.fileName, target), UPLOAD_SOURCE_TYPE[target], `bloom-${crypto.randomUUID()}`);
  const res = await driveFetch(cfg, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST",
    headers: { "Content-Type": parts.contentType },
    body: new Blob([parts.head, file.blob, parts.tail]),
  });
  const saved = await res.json() as { id: string; name?: string; webViewLink?: string };
  return { name: saved.name ?? file.fileName, link: saved.webViewLink ?? `https://drive.google.com/file/d/${encodeURIComponent(saved.id)}/view` };
}

// ------------------------------------------------------------------ bringing in

export interface PickedFile { id: string; name: string; mimeType: string; size: number | null }

/** Opens Google's Picker on Docs, Sheets, PDFs, Word and text files; resolves with what was picked, or nothing. */
export async function pickFromDrive(cfg: DriveConfig, room: number): Promise<PickedFile[]> {
  const t = await driveToken(cfg);
  await loadScript(PICKER_SCRIPT);
  await new Promise<void>((resolve, reject) => {
    const gapi = win().gapi;
    if (!gapi) return reject(new Error("Google Drive couldn't load. Try again."));
    gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google Drive couldn't load. Try again.")) });
  });
  const g = win().google!.picker;
  return new Promise<PickedFile[]>((resolve) => {
    const view = new g.DocsView(g.ViewId.DOCS).setMimeTypes!(PICKER_MIME_TYPES.join(","))
      .setIncludeFolders!(true).setSelectFolderEnabled!(false);
    let builder = new g.PickerBuilder().addView!(view)
      .setOAuthToken!(t).setDeveloperKey!(cfg.apiKey).setAppId!(cfg.appId).setOrigin!(window.location.origin)
      .setTitle!("Add from Google Drive")
      .setCallback!((data: PickerData) => {
        const action = data[g.Response.ACTION];
        if (action === g.Action.CANCEL) resolve([]);
        if (action !== g.Action.PICKED) return;
        const docs = (data[g.Response.DOCUMENTS] as PickerDoc[] | undefined) ?? [];
        resolve(docs.map((d) => ({
          id: String(d[g.Document.ID]),
          name: String(d[g.Document.NAME] ?? "Untitled"),
          mimeType: String(d[g.Document.MIME_TYPE] ?? ""),
          size: typeof d[g.Document.SIZE_BYTES] === "number" ? d[g.Document.SIZE_BYTES] as number : Number(d[g.Document.SIZE_BYTES]) || null,
        })));
      });
    if (room > 1) builder = builder.enableFeature!(g.Feature.MULTISELECT_ENABLED).setMaxItems!(Math.min(room, CHAT_MAX_ATTACHMENTS));
    builder.build!().setVisible!(true);
  });
}

/** Bytes as base64, in chunks so a large file doesn't overflow the call stack. */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A picked file, fetched in this browser and ready to send with the next
 * question: a Google Doc as Markdown (plain text if that fails), a Sheet's
 * first sheet as CSV, a text file as text, a PDF or Word file as its bytes.
 * Checked against the question's other files and the size limits first.
 */
export async function readPickedFile(cfg: DriveConfig, file: PickedFile, current: { size: number }[], uploadLimitBytes: number): Promise<ChatAttachment> {
  const kind = chatAttachmentKind(file.mimeType, file.name);
  if (!kind) throw new Error(`Bloom can't read "${attachmentName(file.name)}". Pick a Google Doc or Sheet, a PDF, a Word file or a text file.`);
  const name = attachmentName(pickedAttachmentName(file.name, file.mimeType));
  if (file.size !== null) {
    const problem = checkChatAttachment({ name, size: file.size }, current, uploadLimitBytes);
    if (problem) throw new Error(problem);
  }
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`;
  const plan = drivePickedFetch(file.mimeType);
  let res: Response;
  if ("export" in plan) {
    try {
      res = await driveFetch(cfg, `${base}/export?mimeType=${encodeURIComponent(plan.export)}`);
    } catch (err) {
      if (!plan.fallback) throw err;
      res = await driveFetch(cfg, `${base}/export?mimeType=${encodeURIComponent(plan.fallback)}`);
    }
  } else {
    res = await driveFetch(cfg, `${base}?alt=media`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (kind === "text") {
    const text = new TextDecoder("utf-8").decode(bytes);
    const problem = checkChatAttachment({ name, size: bytes.length, textLength: text.trim() ? text.length : 0 }, current, uploadLimitBytes);
    if (problem) throw new Error(problem);
    return { name, kind, size: bytes.length, text };
  }
  const problem = checkChatAttachment({ name, size: bytes.length }, current, uploadLimitBytes);
  if (problem) throw new Error(problem);
  return { name, kind, size: bytes.length, data: toBase64(bytes) };
}
