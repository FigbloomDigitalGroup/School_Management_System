// The ledger remembers which Supabase record became which API record, so a run that stops half way carries on
// where it stopped and never creates a second copy. One line of JSON per record, appended as it happens, so a
// crash loses nothing. It belongs to ONE target API (ids differ per API database): keep one state folder per target.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function openLedger(file) {
  mkdirSync(dirname(file), { recursive: true });
  const map = new Map();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { key, id } = JSON.parse(line);
      map.set(key, id);
    }
  } else {
    writeFileSync(file, "", { mode: 0o600 });
  }
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    set(key, id) {
      map.set(key, id);
      appendFileSync(file, `${JSON.stringify({ key, id })}\n`);
    },
    hasAny: (keys) => keys.some((k) => map.has(k)),
    size: () => map.size,
  };
}
