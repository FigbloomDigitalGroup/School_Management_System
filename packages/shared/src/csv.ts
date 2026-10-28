/** Handles quoted fields (a name with a comma in it) without pulling in a CSV library. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Non-blank lines of a pasted or uploaded CSV, whatever its line endings. */
export function csvLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
}

/** One CSV field, quoted only when it has to be (a comma, a quote, a line break). */
export function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A header row and data rows as CSV text, the same shape splitCsvLine() reads back. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}

/** A number as written in a table, which no spreadsheet would read as a formula. */
const PLAIN_NUMBER = /^[-−]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

/**
 * A cell that can't run as a spreadsheet formula: text starting with = + - @
 * (or a tab or carriage return) gets a leading apostrophe, so Excel, Sheets
 * and LibreOffice show it as text. A plain negative number ("-1,250") is left
 * as it is.
 */
export function csvFormulaSafe(value: string): string {
  if (!/^[=+\-@\t\r]/.test(value) || PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

/**
 * CSV for opening in a spreadsheet (RFC 4180): CRLF between rows, quoting
 * where needed, every cell guarded by csvFormulaSafe(), and a UTF-8 byte order
 * mark so Excel reads accented and Swahili text as UTF-8.
 */
export function toSpreadsheetCsv(header: string[], rows: string[][]): string {
  const line = (r: string[]) => r.map((c) => csvCell(csvFormulaSafe(c))).join(",");
  return `${String.fromCharCode(0xfeff)}${[line(header), ...rows.map(line)].join("\r\n")}\r\n`;
}
