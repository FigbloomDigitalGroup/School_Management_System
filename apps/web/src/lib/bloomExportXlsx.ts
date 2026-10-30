/**
 * Tables from a Bloom reply as an Excel workbook, one sheet per table. The
 * workbook is written by packages/shared xlsx.ts (a few SpreadsheetML parts in
 * an uncompressed zip, a few kilobytes of code) instead of exceljs, which made
 * this chunk 939 KB. Loaded on demand through bloomExport.ts.
 *
 * The header row is bold and shaded, and stays in view. A cell that clearly
 * holds a number ("1,250", "KES 1,250") becomes that number; everything else
 * stays text, guarded so nothing a model wrote can run as a formula.
 */
import { tablesXlsx } from "../../../../packages/shared/src/xlsx";
import type { ReplyTable } from "../../../../packages/shared/src/bloomExport";

/** The workbook's bytes. */
export async function renderTablesXlsx(tables: ReplyTable[], opts: { title: string; schoolName: string; disclaimer: string }): Promise<Uint8Array> {
  return tablesXlsx(tables, { ...opts, created: new Date() });
}
