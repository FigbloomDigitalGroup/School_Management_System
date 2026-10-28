/**
 * Tables from a Bloom reply as an Excel workbook, one sheet per table, built
 * with exceljs. Loaded on demand through bloomExport.ts, so exceljs stays out
 * of the chat page's bundle.
 *
 * The header row is bold. A cell that clearly holds a number ("1,250",
 * "KES 1,250") becomes that number; everything else stays text, guarded so
 * nothing a model wrote can run as a formula.
 */
import * as ExcelJSModule from "exceljs";
import { csvFormulaSafe } from "../../../../packages/shared/src/csv";
import { sheetName, spreadsheetNumber, type ReplyTable } from "../../../../packages/shared/src/bloomExport";

// exceljs ships for the browser as a UMD bundle: its classes may come as the default export
type ExcelJS = typeof ExcelJSModule;
const excel: ExcelJS = (ExcelJSModule as unknown as { default?: ExcelJS }).default ?? ExcelJSModule;

/** The workbook's bytes. */
export async function renderTablesXlsx(tables: ReplyTable[], opts: { title: string; schoolName: string; disclaimer: string }): Promise<Uint8Array> {
  const wb = new excel.Workbook();
  wb.creator = opts.schoolName || "Figbloom School Systems";
  wb.title = opts.title;
  wb.description = opts.disclaimer;
  const taken = new Set<string>();

  for (const t of tables) {
    const ws = wb.addWorksheet(sheetName(t.name, taken), { views: [{ state: "frozen", ySplit: 1 }] });
    const header = ws.addRow(t.head.map((h) => csvFormulaSafe(h)));
    header.font = { bold: true };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1EF" } };
    for (const r of t.rows) ws.addRow(r.map((c) => spreadsheetNumber(c) ?? csvFormulaSafe(c)));
    ws.columns.forEach((col, i) => {
      const longest = Math.max(t.head[i]?.length ?? 0, ...t.rows.map((r) => r[i]?.length ?? 0));
      col.width = Math.min(60, Math.max(8, longest + 2));
      col.alignment = { vertical: "top", wrapText: longest > 60 };
    });
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
