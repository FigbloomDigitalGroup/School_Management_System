import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * QA 14 (FIG-1247): does scripts/security-scan.sh actually fail on the attacks it says it catches?
 *
 * Each case builds a small throwaway git repository in the system's temp folder, commits a clean base, plants one attack, and runs
 * the real script on it. The script's exit code is what CI and the pre-build check rely on: 0 passes, anything else stops the build.
 *   - the clean base must pass (otherwise every "fails" below would prove nothing),
 *   - each of the eight things the script's header promises to catch must fail,
 *   - then a second group of attacks that do NOT look like the September 2026 one (different names, a lifecycle script it does not
 *     list, a file it does not read): these are `it.fails` because the script lets them through today; each one passes while that is
 *     true and fails the day the script catches it, and then it becomes a plain `it`.
 *
 * Needs `sh`, `git` and `node` on the PATH (always true in CI and in Git Bash). Without them the tests are skipped, not passed.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "security-scan.sh");
const tools = ["sh", "git", "node"].every((c) => spawnSync(c, c === "sh" ? ["-c", "exit 0"] : ["--version"]).status === 0);
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The three September 2026 signatures the scan looks for, put together at run time. Written out in full they would make the scan
// fail on this very file: it reads every tracked file and skips only itself.
const SIGNATURE_HEX = ["_", "0x"].join("");
const SIGNATURE_VSCODE = ["app-vscode", "eval"].join("-");
const SIGNATURE_HUMAN = ["verify", "human"].join("-");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.email=qa@example.invalid", "-c", "user.name=qa", ...args], { cwd, stdio: "pipe" });

/** A clean repo the script passes on, then `plant` changes it, everything is staged, and the script's exit code comes back. */
function scan(plant?: (dir: string) => void): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "qa14-scan-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "apps", "web"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts", "security-scan.sh"));
  writeFileSync(join(dir, ".gitignore"), ".env\n.env.*\nnode_modules\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lab", scripts: { build: "vite build" } }));
  writeFileSync(join(dir, "apps", "web", "postcss.config.js"), "module.exports = { plugins: [] };\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  plant?.(dir);
  git(dir, "add", "-A");
  const r = spawnSync("sh", ["scripts/security-scan.sh"], { cwd: dir, encoding: "utf8" });
  return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}
const put = (dir: string, file: string, text: string) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };

describe.skipIf(!tools)("scripts/security-scan.sh: what it promises to catch", () => {
  it("passes on a clean repository (so a failure below is the attack's doing)", () => {
    const r = scan();
    expect(r.output).toContain("Security scan passed.");
    expect(r.code).toBe(0);
  });

  const MUST_FAIL: [string, (d: string) => void, RegExp][] = [
    ["1 the hex-named-variables signature in a postcss config", (d) => put(d, "apps/web/postcss.config.js", `var ${SIGNATURE_HEX}1a2b=1;module.exports={};\n`), new RegExp(SIGNATURE_HEX)],
    ["1 the editor-eval indicator", (d) => put(d, "apps/web/vite.config.js", `// ${SIGNATURE_VSCODE}\nmodule.exports={};\n`), new RegExp(SIGNATURE_VSCODE)],
    ["1 the human-check indicator", (d) => put(d, "apps/web/tailwind.config.js", `const s='${SIGNATURE_HUMAN}';module.exports={};\n`), new RegExp(SIGNATURE_HUMAN)],
    ["2 a config file grown past 5,000 bytes", (d) => put(d, "apps/web/vite.config.js", `module.exports={};\n// ${"x".repeat(6000)}\n`), /over 5000 bytes/],
    ["3 code after 150 spaces on one line", (d) => put(d, "apps/web/a.js", `var a=1;${" ".repeat(200)}evil()\n`), /whitespace/],
    ["4 a font file that starts with JavaScript", (d) => put(d, "apps/web/font.woff2", "function evil(){}\n"), /font/],
    ["5 an editor task that runs when the folder opens", (d) => put(d, ".vscode/tasks.json", '{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}'), /folder open/],
    ["5 a tracked config.bat", (d) => put(d, "config.bat", "echo hi\n"), /config\.bat/],
    ["6 .gitignore no longer ignores .env", (d) => put(d, ".gitignore", "node_modules\n"), /\.gitignore no longer ignores \.env/],
    ["6 .gitignore hides config.bat", (d) => put(d, ".gitignore", ".env\n.env.*\nconfig.bat\n"), /hides config\.bat/],
    ["7 a postinstall script in a package.json", (d) => put(d, "package.json", JSON.stringify({ name: "lab", scripts: { postinstall: "node x.js" } })), /postinstall/],
    ["7 a preinstall script in a nested package.json", (d) => put(d, "apps/web/package.json", JSON.stringify({ name: "w", scripts: { preinstall: "node x.js" } })), /preinstall/],
    ["8 a lockfile entry from a git address, not the npm registry", (d) => put(d, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/x": { resolved: "git+https://github.com/x/y.git", integrity: "sha512-abc" } } })), /not from the npm registry/],
    ["8 a lockfile entry with no integrity hash", (d) => put(d, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/x": { resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" } } })), /no integrity hash/],
  ];
  for (const [name, plant, message] of MUST_FAIL) {
    it(`fails on: ${name}`, () => {
      const r = scan(plant);
      expect(r.code, r.output).not.toBe(0);
      expect(r.output).toMatch(message);
    });
  }
});

describe.skipIf(!tools)("scripts/security-scan.sh: attacks that do not look like the September 2026 one", () => {
  // None of these is caught today: the script looks for that attack's names, sizes and files. A new payload only has to use
  // other names, stay small, or sit in a file the script does not read.
  const SLIPS: [string, (d: string) => void][] = [
    ["A a small obfuscated payload that avoids the September names (base64 and eval in the postcss config)", (d) =>
      put(d, "apps/web/postcss.config.js", 'const a=Buffer.from("cmVxdWlyZSgiY2hpbGRfcHJvY2VzcyIp","base64").toString();eval(a);module.exports={plugins:[]};\n')],
    ["B a prepare script (npm runs it on every local npm install)", (d) =>
      put(d, "package.json", JSON.stringify({ name: "lab", scripts: { prepare: "node x.js" } }))],
    ["C a payload in .eslintrc.cjs (loaded automatically, but not named *.config.*)", (d) =>
      put(d, ".eslintrc.cjs", 'eval(require("fs").readFileSync("x","utf8"));module.exports={};\n')],
    ["D a payload in a TypeScript config, vite.config.mts", (d) =>
      put(d, "apps/web/vite.config.mts", 'import {execSync} from "child_process"; execSync("calc"); export default {};\n')],
    ["E a tracked .npmrc that turns install scripts back on", (d) => put(d, ".npmrc", "ignore-scripts=false\nscript-shell=/bin/sh\n")],
    ["F a workflow that runs pull-request code with the release secrets", (d) =>
      put(d, ".github/workflows/x.yml", "on: pull_request_target\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.MOBILE_KEYSTORE_BASE64 }}\n")],
  ];
  for (const [name, plant] of SLIPS) {
    it.fails(`QA14-SCAN FIG-1462 ${name} is stopped by the scan`, () => {
      const r = scan(plant);
      expect(r.code, r.output).not.toBe(0);
    });
  }
});
