/**
 * Google Drive, Docs and Sheets for Bloom (web): the pure parts. The browser
 * side (apps/web lib/googleDrive.ts) signs in with Google Identity Services'
 * token model for the `drive.file` scope only, so the app can see and change
 * only files the person picks in Google's Picker or creates from Bloom. The
 * access token lives in the page's memory for its hour; nothing about the
 * Google account is stored by Figbloom.
 */

/** The one scope asked for: files the person opens or creates with this app, nothing else in their Drive. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PDF_TYPE = "application/pdf";

/** What the Picker offers for "Add from Google Drive": Docs, Sheets, PDFs, Word files and plain text. */
export const PICKER_MIME_TYPES = [GOOGLE_DOC, GOOGLE_SHEET, PDF_TYPE, DOCX_TYPE, "text/plain"] as const;

/** Where a Bloom file goes in Drive: converted to a Google Doc or Sheet, or kept as a PDF. */
export type DriveTarget = "doc" | "sheet" | "pdf";

/** Drive's simple multipart upload takes files up to 5 MB; Bloom's documents are far smaller. */
export const DRIVE_MULTIPART_MAX_BYTES = 5 * 1024 ** 2;

/**
 * The Drive file's name: the download's name, without the extension when
 * Drive converts the file into a Google Doc or Sheet ("Bloom - Half term
 * circular - 2026-10-28"), with it for a PDF.
 */
export function driveFileName(downloadName: string, target: DriveTarget): string {
  return target === "pdf" ? downloadName : downloadName.replace(/\.(docx|xlsx)$/i, "");
}

/** The Drive metadata for an upload: its name and, to have Drive convert it, the Google type. */
export function driveUploadMetadata(downloadName: string, target: DriveTarget): { name: string; mimeType: string } {
  return {
    name: driveFileName(downloadName, target),
    mimeType: target === "doc" ? GOOGLE_DOC : target === "sheet" ? GOOGLE_SHEET : PDF_TYPE,
  };
}

/** The type of the bytes being uploaded for each target. */
export const UPLOAD_SOURCE_TYPE: Record<DriveTarget, string> = { doc: DOCX_TYPE, sheet: XLSX_TYPE, pdf: PDF_TYPE };

/**
 * A multipart/related body for Drive's `uploadType=multipart`: the JSON
 * metadata, then the file. The file's bytes go between `head` and `tail`;
 * the browser joins the three (a Blob), so this stays free of DOM types.
 */
export function driveMultipart(metadata: { name: string; mimeType: string }, sourceType: string, boundary: string): { contentType: string; head: string; tail: string } {
  if (!/^[A-Za-z0-9'()+_,\-./:=?]{1,70}$/.test(boundary)) throw new Error("A multipart boundary must be 1 to 70 plain characters.");
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    head: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
      + `--${boundary}\r\nContent-Type: ${sourceType}\r\n\r\n`,
    tail: `\r\n--${boundary}--\r\n`,
  };
}

/** The toast's link after a save: "Open in Google Docs". */
export function driveOpenLabel(target: DriveTarget): string {
  return target === "doc" ? "Open in Google Docs" : target === "sheet" ? "Open in Google Sheets" : "Open in Google Drive";
}

/** How a picked file is fetched: a Google Doc or Sheet exported as text, anything else downloaded as it is. */
export function drivePickedFetch(mimeType: string): { export: string; fallback?: string } | { download: true } {
  if (mimeType === GOOGLE_DOC) return { export: "text/markdown", fallback: "text/plain" };
  // Drive exports only a spreadsheet's first sheet as CSV
  if (mimeType === GOOGLE_SHEET) return { export: "text/csv" };
  return { download: true };
}

/** The name a picked Google Doc or Sheet is attached as: its title, marked as what it was read as. */
export function pickedAttachmentName(name: string, mimeType: string): string {
  if (mimeType === GOOGLE_SHEET) return `${name} (Google Sheet, first sheet)`;
  if (mimeType === GOOGLE_DOC) return `${name} (Google Doc)`;
  return name;
}

/** "name@…" for the header: enough of the address to know which account, not the whole of it. */
export function shortAccount(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return email;
  return `${email.slice(0, at)}@…`;
}
