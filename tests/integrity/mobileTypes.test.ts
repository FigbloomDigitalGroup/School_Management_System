import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * WP-A1 review R-08. React Native code must not type-check against Node's globals (Buffer, process,
 * require, fs types): they do not exist at runtime on the device. Four Jest test files need Node's
 * `setTimeout` overload, so they get their own TypeScript program (tsconfig.node-tests.json); the
 * app program (tsconfig.json) has no Node types. These checks fail if Node types leak back into the app program.
 */
const MOBILE = resolve(__dirname, "..", "..", "apps", "mobile");
const APP_CONFIG = join(MOBILE, "tsconfig.json");
const NODE_TEST_CONFIG = join(MOBILE, "tsconfig.node-tests.json");

function readJson(path: string): {
  compilerOptions?: { types?: string[] };
  include?: string[];
  exclude?: string[];
} {
  const r = ts.readConfigFile(path, ts.sys.readFile);
  if (r.error) throw new Error(`cannot read ${path}`);
  return r.config;
}

/** Compile one virtual file, placed inside apps/mobile so type roots resolve, with a config's own options. */
function diagnosticsFor(configPath: string, source: string): string[] {
  const parsed = ts.parseJsonConfigFileContent(readJson(configPath), ts.sys, dirname(configPath));
  const virtual = join(MOBILE, "src", "__node_leak_probe__.ts").split("\\").join("/");
  const host = ts.createCompilerHost({ ...parsed.options, noEmit: true });
  const realRead = host.readFile.bind(host);
  const realExists = host.fileExists.bind(host);
  const realGet = host.getSourceFile.bind(host);
  host.fileExists = (f) => f.split("\\").join("/") === virtual || realExists(f);
  host.readFile = (f) => (f.split("\\").join("/") === virtual ? source : realRead(f));
  host.getSourceFile = (f, lang, onErr, shouldCreate) =>
    f.split("\\").join("/") === virtual
      ? ts.createSourceFile(f, source, lang)
      : realGet(f, lang, onErr, shouldCreate);
  const program = ts.createProgram({ rootNames: [virtual], options: { ...parsed.options, noEmit: true }, host });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.split("\\").join("/") === virtual)
    .map((d) => `TS${d.code}`);
}

describe("apps/mobile TypeScript programs keep Node types out of React Native code (review R-08)", () => {
  const app = readJson(APP_CONFIG);
  const nodeTests = readJson(NODE_TEST_CONFIG);

  it("the app program does not list node in its types", () => {
    expect(app.compilerOptions?.types).toEqual(["react-native", "jest"]);
  });

  it("only the node-tests program has node types, and it covers exactly the files the app program excludes", () => {
    expect(nodeTests.compilerOptions?.types).toContain("node");
    expect([...(nodeTests.include ?? [])].sort()).toEqual([...(app.exclude ?? [])].sort());
    expect((nodeTests.include ?? []).length).toBe(4);
    for (const f of nodeTests.include ?? []) {
      expect(f, f).toMatch(/\.test\.tsx?$/); // test files only, never application source
      expect(existsSync(join(MOBILE, f)), f).toBe(true);
    }
  });

  it("the typecheck script runs both programs", () => {
    const pkg = JSON.parse(readFileSync(join(MOBILE, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toContain("tsc --noEmit -p tsconfig.node-tests.json");
    expect(pkg.scripts.typecheck).toMatch(/^tsc --noEmit &&/);
  });

  it("negative control: Node globals and modules do not type-check in the app program", () => {
    const d = diagnosticsFor(
      APP_CONFIG,
      `export const a = Buffer.from("x");\nexport const b = process.env.HOME;\nimport fs from "node:fs";\nexport const c = fs.readFileSync;\n`,
    );
    expect(d.length).toBeGreaterThanOrEqual(3);
    // "Cannot find name 'Buffer'/'process'. Do you need to install type definitions for node?" (TS2580 or, in newer
    // TypeScript, TS2591) and "Cannot find module 'node:fs'" (TS2307).
    expect(d.some((c) => c === "TS2580" || c === "TS2591")).toBe(true);
    expect(d).toContain("TS2307");
  }, 120_000);

  it("control: the same source type-checks in the node-tests program, so the probe is capable of passing", () => {
    expect(
      diagnosticsFor(
        NODE_TEST_CONFIG,
        `export const a = Buffer.from("x");\nexport const b = process.env.HOME;\nimport fs from "node:fs";\nexport const c = fs.readFileSync;\n`,
      ),
    ).toEqual([]);
  }, 120_000);
});
