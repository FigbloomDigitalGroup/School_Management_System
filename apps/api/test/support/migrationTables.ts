import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * Tables created by migrations numbered `fromNumber` .. `toNumberInclusive`.
 * Shared by Phase 3 and Stage 9/10 catalogue tests — do not import from a `*.test.ts` file.
 */
export function tablesCreatedFrom(
  fromNumber: number,
  dir = DEFAULT_MIGRATIONS_DIR,
  toNumberInclusive = Number.POSITIVE_INFINITY,
): string[] {
  const tables = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f))) {
    const n = Number(file.split("_")[0]);
    if (n < fromNumber || n > toNumberInclusive) continue;
    const sql = readFileSync(`${dir}${file}`, "utf8");
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      tables.add(m[1]!.toLowerCase());
    }
  }
  return [...tables].sort();
}

export function missingFromInventory(created: string[], inventory: string[]): string[] {
  const have = new Set(inventory);
  return created.filter((t) => !have.has(t));
}

export { DEFAULT_MIGRATIONS_DIR as MIGRATIONS_DIR };
