/**
 * Bloom downloads, for loading on demand:
 *
 *   const { downloadBloomExport } = await import("../../lib/bloomExport");
 *
 * A reply or a whole chat as PDF (pdf-lib, with Noto Sans) or Word (docx),
 * and a reply's tables as Excel (packages/shared xlsx.ts) or CSV. Each
 * renderer is a further chunk fetched only for its own format, so none of
 * them weighs on the chat page. The
 * Markdown-to-document work lives in packages/shared (bloomExport.ts), where
 * it's tested.
 */
import { toSpreadsheetCsv } from "../../../../packages/shared/src/csv";
import {
  BLOOM_EXPORT_DISCLAIMER, bloomExportFileName, buildBloomExport, exportTitle, replyTables, type ExportDocument, type ExportTurn,
} from "../../../../packages/shared/src/bloomExport";

const TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv;charset=utf-8",
} as const;

/** Hands a file to the browser as a download. */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface BloomExportRequest {
  format: "pdf" | "docx";
  /** The saved chat's name; null for a chat not saved yet. */
  chatTitle: string | null;
  schoolName: string;
  /** What goes in the file: one answer, or the whole chat. */
  turns: ExportTurn[];
  wholeChat: boolean;
  /** The chat so far, for a title when it has no name (its first question). Defaults to `turns`. */
  context?: ExportTurn[];
}

/** A reply or a whole chat as a PDF or Word download. */
export async function downloadBloomExport(req: BloomExportRequest): Promise<void> {
  const now = new Date();
  const title = exportTitle(req.chatTitle, req.context ?? req.turns);
  const doc = buildBloomExport({ title, schoolName: req.schoolName, turns: req.turns, labelTurns: req.wholeChat, now });
  const blob = req.format === "pdf"
    ? new Blob([await renderPdf(doc) as BlobPart], { type: TYPES.pdf })
    : await (await import("./bloomExportDocx")).renderBloomDocx(doc);
  saveBlob(blob, bloomExportFileName(title, now, req.format));
}

/** The PDF, in Noto Sans fetched on demand (bloomExportFonts.ts). */
async function renderPdf(doc: ExportDocument): Promise<Uint8Array> {
  const [{ renderBloomPdf }, { loadBloomFont }] = await Promise.all([import("./bloomExportPdf"), import("./bloomExportFonts")]);
  return renderBloomPdf(doc, loadBloomFont);
}

export interface TableExportRequest {
  format: "xlsx" | "csv";
  /** The reply's Markdown. */
  content: string;
  /** Which of its tables; left out, every table (Excel: a sheet each). */
  index?: number;
  chatTitle: string | null;
  schoolName: string;
  context: ExportTurn[];
}

/** A reply's tables as an Excel workbook, or one table as CSV. */
export async function downloadTableExport(req: TableExportRequest): Promise<void> {
  const all = replyTables(req.content);
  const tables = req.index === undefined ? all : all.slice(req.index, req.index + 1);
  const table = tables[0];
  if (!table) throw new Error("That table couldn't be found.");
  const now = new Date();
  const title = exportTitle(req.chatTitle, req.context);
  // a single table is named in the file name; the whole set goes by the chat's title
  const name = tables.length === 1 && all.length > 1 ? `${title} - ${table.name}` : title;
  if (req.format === "csv") {
    saveBlob(new Blob([toSpreadsheetCsv(table.head, table.rows)], { type: TYPES.csv }), bloomExportFileName(name, now, "csv"));
    return;
  }
  const { renderTablesXlsx } = await import("./bloomExportXlsx");
  const bytes = await renderTablesXlsx(tables, { title, schoolName: req.schoolName, disclaimer: BLOOM_EXPORT_DISCLAIMER });
  saveBlob(new Blob([bytes as BlobPart], { type: TYPES.xlsx }), bloomExportFileName(name, now, "xlsx"));
}
