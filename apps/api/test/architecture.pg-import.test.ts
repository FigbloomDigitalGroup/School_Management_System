import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PG_IMPORT = /from\s+["']pg(?:\/[^"']*)?["']|import\s*\(\s*["']pg(?:\/[^"']*)?["']\s*\)|require\(\s*["']pg(?:\/[^"']*)?["']\s*\)/;

export function findPgImports(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) {
        if (name.name === "db" && relative(root, dir) === "") continue;
        walk(full);
        continue;
      }
      if (!name.name.endsWith(".ts")) continue;
      const text = readFileSync(full, "utf8");
      if (PG_IMPORT.test(text)) hits.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return hits;
}

describe("architecture: pg imports", () => {
  it("allows pg only under src/db", () => {
    const src = join(process.cwd(), "src");
    expect(findPgImports(src)).toEqual([]);
  });

  it("negative control: a pg import outside src/db is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "figbloom-pg-import-"));
    try {
      writeFileSync(join(dir, "leak.ts"), `import pg from "pg";\nexport const x = pg;\n`, "utf8");
      expect(findPgImports(dir)).toEqual(["leak.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
