#!/bin/sh
# Supply-chain tripwires. Background: .agents/SECURITY.md (the September 2026 attacks).
#
#   sh scripts/security-scan.sh
#
# Run it before installing, building or committing; CI runs it first and runs
# nothing else if it fails. It reads only files git tracks, never executes any
# of them, and exits non-zero naming every finding. It looks for what those
# attacks actually did:
#   1. their signatures in tracked source/config files
#   2. a config file that has grown far beyond its normal size
#   3. code hidden behind a long run of whitespace at the end of a line
#   4. font files that are really JavaScript
#   5. an editor task that runs on folder open, or a dropped config.bat
#   6. a .gitignore that no longer ignores .env files
#   7. install/postinstall scripts in our own package.json files
#   8. lockfile entries that don't come from the npm registry with an integrity hash
#
# This file names the signatures on purpose, so the signature search skips it.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

failed=0
fail() { printf 'SECURITY CHECK FAILED: %s\n' "$1" >&2; failed=1; }

SELF='scripts/security-scan.sh'
src_list=$(mktemp)
trap 'rm -f "$src_list"' EXIT

git ls-files -z -- '*.js' '*.cjs' '*.mjs' '*.jsx' '*.ts' '*.tsx' '*.json' '*.bat' '*.cmd' '*.ps1' '*.sh' \
  '*.yml' '*.yaml' '*.html' '*.gradle' '*.kts' '*.kt' '*.java' ':!:package-lock.json' ":!:$SELF" > "$src_list"

# 1. signatures -------------------------------------------------------------
hits=$(xargs -0 grep -nE -e '_0x' -e 'app-vscode-eval' -e 'verify-human' < "$src_list" 2>/dev/null)
if [ -n "$hits" ]; then
  fail "an attack signature (_0x / app-vscode-eval / verify-human) appears in tracked files:"
  printf '%s\n' "$hits" | cut -c1-200 | head -20 >&2
fi

# 2. config files that should be small --------------------------------------
big=$(git ls-files -z -- '*.config.js' '*.config.ts' '*.config.cjs' '*.config.mjs' | xargs -0 -r wc -c | awk '$2 != "total" && $1 > 5000 { print $2 " (" $1 " bytes)" }')
[ -n "$big" ] && fail "config file(s) over 5000 bytes, normally they are well under: $big"

# 3. code hidden behind a long run of whitespace ----------------------------
hidden=$(git ls-files -z -- '*.js' '*.cjs' '*.mjs' '*.jsx' '*.ts' '*.tsx' | xargs -0 -r grep -nE '[[:space:]]{150,}[^[:space:]]' 2>/dev/null | cut -c1-120)
if [ -n "$hidden" ]; then
  fail "text follows 150+ whitespace characters on one line (a way to hide code off-screen):"
  printf '%s\n' "$hidden" | head -10 >&2
fi

# 4. "fonts" that are really JavaScript -------------------------------------
fake_fonts=$(git ls-files -z -- '*.woff' '*.woff2' '*.ttf' '*.eot' '*.otf' | xargs -0 -r sh -c 'for f in "$@"; do head -c 400 "$f" | grep -aqE "function|var |const |let |eval|require|=>|<script" && echo "$f"; done' sh)
[ -n "$fake_fonts" ] && fail "named like a font but starts with code: $fake_fonts"

# 5. auto-run editor tasks, dropped batch files -----------------------------
tasks=$(git ls-files -z -- '.vscode/tasks.json' '*/.vscode/tasks.json' | xargs -0 -r grep -l 'folderOpen' 2>/dev/null)
[ -n "$tasks" ] && fail "an editor task runs on folder open: $tasks"
bat=$(git ls-files | grep -E '(^|/)config\.bat$')
[ -n "$bat" ] && fail "config.bat is tracked: $bat"

# 6. .gitignore still ignores .env files ------------------------------------
grep -qxF '.env' .gitignore || fail ".gitignore no longer ignores .env"
grep -qxF '.env.*' .gitignore || fail ".gitignore no longer ignores .env.*"
grep -q 'config\.bat' .gitignore && fail ".gitignore hides config.bat (a dropped file would not show in git status)"

# 7 + 8. lifecycle scripts and the lockfile (needs node, which every job and dev machine has)
node - <<'NODE' || failed=1
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
let bad = 0;
const fail = (m) => { console.error("SECURITY CHECK FAILED: " + m); bad = 1; };

const pkgs = execFileSync("git", ["ls-files", "-z", "--", "package.json", "*/package.json"]).toString().split("\0").filter(Boolean);
for (const f of pkgs) {
  const scripts = JSON.parse(fs.readFileSync(f, "utf8")).scripts ?? {};
  for (const hook of ["preinstall", "install", "postinstall"]) {
    if (scripts[hook]) fail(`${f} runs a ${hook} script on every install: ${scripts[hook]}`);
  }
}

if (fs.existsSync("package-lock.json")) {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path || p.link || !p.resolved) continue;
    if (!p.resolved.startsWith("https://registry.npmjs.org/")) fail(`package-lock.json: ${path} is not from the npm registry (${p.resolved})`);
    else if (!p.integrity) fail(`package-lock.json: ${path} has no integrity hash`);
  }
}
process.exit(bad);
NODE

if [ "$failed" -ne 0 ]; then
  echo "Security scan FAILED. Do not install, build or merge until each finding is explained." >&2
  exit 1
fi
echo "Security scan passed."
