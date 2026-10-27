/**
 * Importing an existing paper: getting the teacher's file from storage to
 * the model. PDFs and page photos go to the model as they are (both
 * providers read them natively, scans included); a Word file is opened here
 * and sent as its text, since neither provider takes .docx.
 *
 * The file waits in the teacher's own folder in private-documents
 * (<tenant>/paper-imports/<profile>/<file>, see packages/shared
 * paperImport.ts) and is deleted as soon as it has been read: the paper,
 * and any marking scheme in it, is never kept here.
 */

import { strFromU8, unzipSync } from "npm:fflate@0.8.2";
import type { AiPart } from "./providers.ts";
import { BadInput, paperImportPrompt, type PaperImportRequest } from "./tasks.ts";

const BUCKET = "private-documents";

/** Mirrors packages/shared paperImport.ts: what the app lets through, checked again here. */
export const MAX_BYTES = 20 * 1024 ** 2;
export const MAX_PDF_PAGES = 30;
/** About 40 pages of typed paper: more than any single exam. */
export const MAX_DOCX_CHARS = 120_000;

export type FileKind = "pdf" | "docx" | "png" | "jpeg";

/** What a file really is, from its first bytes, not its name. */
export function sniff(bytes: Uint8Array): FileKind | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "pdf"; // %PDF
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "docx"; // a zip; docxText() checks it's really Word
  return null;
}

/**
 * Roughly how many pages a PDF has, or null when it can't tell (page objects
 * inside compressed object streams). Only used to turn away a whole textbook
 * before paying to send it.
 */
export function pdfPageCount(bytes: Uint8Array): number | null {
  const raw = new TextDecoder("latin1").decode(bytes);
  const pages = raw.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (pages) return pages;
  const counts = [...raw.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : null;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m);

const roman = (n: number) =>
  [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]].reduce((out, [v, r]) => {
    let s = out;
    while (n >= (v as number)) { s += r; n -= v as number; }
    return s;
  }, "");

/**
 * A Word file's text, paragraph by paragraph. Pictures and drawings become
 * "[FIGURE]" so the model can flag the questions that need them. Word's
 * automatic numbering isn't in the text, so it's rebuilt as 1. / (a) / (i)
 * by list level: close to how papers are numbered, but the prompt tells the
 * model it may be off.
 */
export function docxText(bytes: Uint8Array): string {
  let xml: Uint8Array | undefined;
  try {
    xml = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" })["word/document.xml"];
  } catch { /* not a zip at all */ }
  if (!xml) throw new BadInput("That file couldn't be opened as a Word document. Save it again as .docx, or as a PDF.");

  const counters = new Map<string, number[]>();
  const lines: string[] = [];
  for (const para of strFromU8(xml).split(/<\/w:p>/)) {
    let line = "";
    for (const m of para.matchAll(/<(w|m):t(?:\s[^>]*)?>([^<]*)<\/\1:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:drawing\b|<w:pict\b|<w:object\b/g)) {
      if (m[2] !== undefined) line += decodeXml(m[2]);
      else if (m[0] === "<w:tab/>") line += "\t";
      else if (m[0].startsWith("<w:br")) line += "\n";
      else line += " [FIGURE] ";
    }
    const num = /<w:numPr>[\s\S]*?<w:ilvl w:val="(\d+)"\/>[\s\S]*?<w:numId w:val="(\d+)"\/>/.exec(para);
    if (num && num[2] !== "0" && line.trim()) {
      const level = Math.min(Number(num[1]), 2);
      const c = counters.get(num[2]!) ?? [0, 0, 0];
      c[level]! += 1;
      for (let l = level + 1; l < 3; l++) c[l] = 0;
      counters.set(num[2]!, c);
      const n = c[level]!;
      line = `${level === 0 ? `${n}.` : level === 1 ? `(${String.fromCharCode(96 + Math.min(n, 26))})` : `(${roman(n)})`} ${line}`;
    }
    lines.push(line.replace(/[ \t]+$/g, ""));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Base64 without blowing the call stack on a 20 MB file. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Downloads the staged files, and deletes them whatever happens: once read,
 * or if the request is turned away.
 */
// deno-lint-ignore no-explicit-any
export async function readStaged(admin: any, paths: string[]): Promise<Uint8Array[]> {
  try {
    const out: Uint8Array[] = [];
    for (const path of paths) {
      const { data, error } = await admin.storage.from(BUCKET).download(path);
      if (error || !data) throw new BadInput("The paper didn't finish uploading. Please choose it again.");
      out.push(new Uint8Array(await data.arrayBuffer()));
    }
    return out;
  } finally {
    const { error } = await admin.storage.from(BUCKET).remove(paths);
    if (error) console.error("ai-assist: could not delete a staged paper", error.message);
  }
}

/** The model's input for an import: the document (or its text), then what to do with it. */
export function paperImportContent(req: PaperImportRequest, files: Uint8Array[]): AiPart[] {
  const total = files.reduce((n, f) => n + f.length, 0);
  if (total > MAX_BYTES) throw new BadInput(`Bloom can read up to ${MAX_BYTES / 1024 ** 2} MB at a time. Split the paper, or take smaller photos.`);
  const kinds = files.map(sniff);
  if (kinds.some((k) => k === null)) throw new BadInput("Bloom can read PDF, Word (.docx), JPG and PNG files.");
  if (files.length > 1 && kinds.some((k) => k !== "png" && k !== "jpeg")) {
    throw new BadInput("Choose one PDF or Word file, or several photos of the pages, not a mix.");
  }

  const parts: AiPart[] = [];
  if (kinds[0] === "pdf") {
    const pages = pdfPageCount(files[0]!);
    if (pages !== null && pages > MAX_PDF_PAGES) {
      throw new BadInput(`That PDF has ${pages} pages. Bloom reads up to ${MAX_PDF_PAGES} at a time: split off the paper you want.`);
    }
    parts.push({ type: "pdf", name: "paper.pdf", data: toBase64(files[0]!) });
  } else if (kinds[0] === "docx") {
    const text = docxText(files[0]!);
    if (!text) throw new BadInput("That Word document is empty.");
    if (text.length > MAX_DOCX_CHARS) throw new BadInput("That Word document is too long to read at once. Split off the paper you want.");
    parts.push({ type: "text", text: `The paper, as text taken from a Word document (automatic numbering rebuilt, so it may be slightly off; [FIGURE] marks a picture or drawing):\n\n<paper>\n${text}\n</paper>` });
  } else {
    kinds.forEach((k, i) => parts.push({ type: "image", mediaType: k === "png" ? "image/png" : "image/jpeg", data: toBase64(files[i]!) }));
  }
  parts.push({ type: "text", text: paperImportPrompt(req, files.length > 1 ? `${files.length} photos of the pages, in order` : kinds[0] === "docx" ? "a Word document" : kinds[0] === "pdf" ? "a PDF" : "a photo of the paper") });
  return parts;
}
