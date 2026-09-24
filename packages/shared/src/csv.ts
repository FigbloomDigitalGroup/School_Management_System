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
