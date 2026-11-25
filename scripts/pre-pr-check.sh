#!/bin/sh
# Run before opening a PR into dev-staging or main. Background: CHANGELOG.md.
#
#   sh scripts/pre-pr-check.sh                 # checks HEAD against origin/main
#   sh scripts/pre-pr-check.sh <ref>           # checks another branch, e.g. origin/dev-joe
#
# It only reads git history and never builds or runs anything. It exits
# non-zero naming every problem. Fix all of them before opening the PR.
#   1. the branch must already contain everything on origin/main
#   2. migrations that are on main must not be edited or deleted
#   3. new migrations must be dated after the newest migration on main
#   4. edge functions that are on main must not be deleted
#   5. a branch that changes code must add a CHANGELOG.md entry
#   6. (warning) new policies calling has_perm / has_office_perm per row
#   7. the supply-chain security scan must pass

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

HEAD_REF=${1:-HEAD}
BASE=origin/main
failed=0
fail() { printf 'PRE-PR CHECK FAILED: %s\n' "$1" >&2; failed=1; }
warn() { printf 'PRE-PR CHECK WARNING: %s\n' "$1" >&2; }

git fetch -q origin main || { echo "Could not fetch origin/main." >&2; exit 2; }

# 1. main is in the branch -----------------------------------------------------
if ! git merge-base --is-ancestor "$BASE" "$HEAD_REF"; then
  missing=$(git rev-list --count "$HEAD_REF..$BASE")
  fail "the branch is missing $missing commit(s) from main. Merge origin/main into it first (CHANGELOG.md, 'Catching up with main'):"
  git log --format='    %h %s' "$HEAD_REF..$BASE" | grep -i 'Merge pull request' | head -20 >&2
fi

# 2. live migrations untouched -------------------------------------------------
changed=$(git diff --name-status "$BASE...$HEAD_REF" -- supabase/migrations | grep -vE '^A' || true)
if [ -n "$changed" ]; then
  fail "migrations that are on main were edited, renamed or deleted. Add a new migration instead:"
  printf '    %s\n' "$changed" >&2
fi

# 3. new migrations dated after main's newest ----------------------------------
newest=$(git ls-tree --name-only "$BASE" supabase/migrations/ | sed 's#.*/##' | grep -E '^[0-9]{14}_' | sort | tail -1)
added=$(git diff --name-only --diff-filter=A "$BASE...$HEAD_REF" -- supabase/migrations | sed 's#.*/##' | sort)
old=$(printf '%s\n' "$added" | awk -v n="$newest" 'NF && $0 < n')
if [ -n "$old" ]; then
  fail "these new migrations are dated before $newest (the newest on main) and would be skipped or refused in production. Rename them to a later timestamp:"
  printf '    %s\n' $old >&2
fi
dupes=$(printf '%s\n' "$added" | cut -c1-14 | sort | uniq -d)
[ -n "$dupes" ] && fail "two new migrations share a timestamp: $dupes"

# 4. live edge functions kept --------------------------------------------------
gone=$(git diff --name-only --diff-filter=D "$BASE...$HEAD_REF" -- 'supabase/functions/*/index.ts' || true)
if [ -n "$gone" ]; then
  fail "edge functions that are live in production were deleted:"
  printf '    %s\n' $gone >&2
fi

# 5. changelog entry -----------------------------------------------------------
code=$(git diff --name-only "$BASE...$HEAD_REF" | grep -vE '\.md$|^docs/|\.test\.|^e2e/|^tests/' || true)
if [ -n "$code" ] && ! git diff --name-only "$BASE...$HEAD_REF" | grep -qx 'CHANGELOG.md'; then
  fail "the branch changes code but doesn't add to CHANGELOG.md. Add what changed under 'Unreleased'."
fi

# 6. per-row permission checks in new policies (warning) -----------------------
for f in $(git diff --name-only --diff-filter=A "$BASE...$HEAD_REF" -- supabase/migrations); do
  if git show "$HEAD_REF:$f" | grep -qiE 'policy' && git show "$HEAD_REF:$f" | grep -qE 'has_(office_)?perm\('; then
    warn "$f calls has_perm/has_office_perm. In a policy that runs once per row; use my_perm_tenant_ids / my_office_tenant_ids (CHANGELOG.md, #374)."
  fi
done

# 7. security scan -------------------------------------------------------------
sh scripts/security-scan.sh >/dev/null 2>&1 || fail "scripts/security-scan.sh failed. Run it, and stop: see .agents/SECURITY.md."

if [ "$failed" -ne 0 ]; then
  echo "Fix the problems above before opening a PR into dev-staging or main." >&2
  exit 1
fi
echo "Pre-PR check passed against $BASE."
