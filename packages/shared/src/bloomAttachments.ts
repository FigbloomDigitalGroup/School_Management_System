import { formatFileSize } from "./materials";
import { IMPORT_MAX_BYTES, IMPORT_MAX_PDF_PAGES } from "./paperImport";

/**
 * Files attached to a Bloom chat question (picked from Google Drive in the
 * web app, googleDrive.ts). They go to the ai-assist "chat" task with that one
 * question and nowhere else: the edge function reads them for the model and
 * keeps nothing, and the saved chat keeps only their names
 * (ai_chat_messages.attachments, 20261102100000_bloom_chat_attachments.sql).
 *
 * A Google Doc or Sheet, or a plain text file, arrives as text (a Doc as
 * Markdown, a Sheet as CSV); a PDF or Word file as its bytes, read by the
 * edge function the way it reads a paper being imported (documents.ts). The
 * limits are the paper import's, checked again by the edge function
 * (tasks.ts CHAT_MAX_ATTACHMENTS, CHAT_ATTACHMENT_MAX_CHARS).
 */

export type ChatAttachmentKind = "text" | "pdf" | "docx";

/** An attachment as the app holds it until the question is sent. `data` is base64. */
export type ChatAttachment =
  | { name: string; kind: "text"; size: number; text: string }
  | { name: string; kind: "pdf" | "docx"; size: number; data: string };

/** Files on one question. */
export const CHAT_MAX_ATTACHMENTS = 3;
/** One document's text: about 40 typed pages, the same as a Word paper being imported. */
export const CHAT_ATTACHMENT_MAX_CHARS = 120_000;
/** Longest attachment name kept with the saved question. */
export const CHAT_ATTACHMENT_NAME_MAX = 200;

/**
 * All of one question's files together: what Bloom can read at once (the
 * paper import's 20 MB), and never more than the project's upload limit
 * (`uploadLimitBytes`, the web app's VITE_MAX_UPLOAD_MB, 50 MB by default).
 */
export function chatAttachmentMaxBytes(uploadLimitBytes: number): number {
  return Math.min(IMPORT_MAX_BYTES, uploadLimitBytes);
}

export const CHAT_ATTACHMENT_MAX_PDF_PAGES = IMPORT_MAX_PDF_PAGES;

/** What a picked file is read as, from its type (or, failing that, its name); null for anything Bloom can't read. */
export function chatAttachmentKind(mimeType: string, name: string): ChatAttachmentKind | null {
  const type = mimeType.toLowerCase();
  const lower = name.toLowerCase();
  if (type === "application/pdf" || (!type && lower.endsWith(".pdf"))) return "pdf";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || (!type && lower.endsWith(".docx"))) return "docx";
  if (type === "application/vnd.google-apps.document" || type === "application/vnd.google-apps.spreadsheet") return "text";
  if (type === "text/plain" || type === "text/markdown" || type === "text/csv" || (!type && /\.(txt|md|csv)$/.test(lower))) return "text";
  return null;
}

/** A name safe to show and save: one line, no control characters, at most CHAT_ATTACHMENT_NAME_MAX characters. */
export function attachmentName(name: string): string {
  const clean = [...name].map((c) => (c.codePointAt(0)! < 0x20 || c === "\u007f" ? " " : c)).join("").replace(/\s+/g, " ").trim();
  return [...(clean || "Untitled")].slice(0, CHAT_ATTACHMENT_NAME_MAX).join("");
}

/**
 * Why `adding` can't join the question's files (`current`), or null when it
 * can: too many files, too much at once, or a document too long to read.
 * `size` is bytes as sent (a text's UTF-8 length counts as its size).
 */
export function checkChatAttachment(
  adding: { name: string; size: number; textLength?: number },
  current: { size: number }[],
  uploadLimitBytes: number,
): string | null {
  if (current.length >= CHAT_MAX_ATTACHMENTS) return `Bloom can read up to ${CHAT_MAX_ATTACHMENTS} files with one question.`;
  const max = chatAttachmentMaxBytes(uploadLimitBytes);
  if (adding.size > max) return `"${attachmentName(adding.name)}" is ${formatFileSize(adding.size)}. Bloom can read up to ${formatFileSize(max)} at a time.`;
  const total = current.reduce((n, a) => n + a.size, 0) + adding.size;
  if (total > max) return `Together these files come to ${formatFileSize(total)}. Bloom can read up to ${formatFileSize(max)} at a time.`;
  if (adding.textLength !== undefined && adding.textLength > CHAT_ATTACHMENT_MAX_CHARS) {
    return `"${attachmentName(adding.name)}" is too long for Bloom to read at once. Copy the part you need into a new document.`;
  }
  if (adding.textLength === 0) return `"${attachmentName(adding.name)}" is empty.`;
  return null;
}

/** How a saved question shows its files: "📎 Lesson plan.docx". */
export function attachmentLabel(name: string): string {
  return `📎 ${name}`;
}
