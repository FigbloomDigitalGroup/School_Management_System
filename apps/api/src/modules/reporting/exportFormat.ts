/** Formula-injection-safe CSV cell escaping (neutralizes =, +, -, @, \t, \r). */
export function csvCell(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  const raw = (value === null || value === undefined ? "" : String(value)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Generates a minimal, spec-compliant PDF 1.4 document with plain text lines.
 * No external binary dependencies.
 */
export function renderSimplePdf(title: string, lines: string[]): Buffer {
  const escapePdf = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7e]/g, " ");
  const contentLines = [title, "", ...lines].slice(0, 45);
  const textOps = contentLines
    .map((line, idx) => (idx === 0 ? `BT /F1 12 Tf 50 760 Td (${escapePdf(line)}) Tj` : `0 -14 Td (${escapePdf(line)}) Tj`))
    .join("\n") + "\nET";

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(textOps, "utf8")} >>\nstream\n${textOps}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(out, "utf8"));
    out += obj;
  }
  const xrefOffset = Buffer.byteLength(out, "utf8");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "utf8");
}
