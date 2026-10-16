#!/usr/bin/env bash
# Privacy check before committing or publishing: lists anything that looks like real data in files git would commit
# (tracked + untracked, minus .gitignore). Prints matches for a human to judge; exits 0.
#   bash scripts/privacy-check.sh            # working tree
#   bash scripts/privacy-check.sh --history        # every blob in all of git history
#   bash scripts/privacy-check.sh --history <ref>  # only the history reachable from <ref> (e.g. the branch to publish)
set -u
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--history" ]; then
  REVS="${2:---all}"
  # `grep .` makes an empty result fail, so the "(none)" fallbacks below work in this mode too
  search() { git rev-list $REVS | while read -r c; do git grep -nIE "$1" "$c" -- . ':!scripts/privacy-check.sh'; done | sort -u | grep .; }
else
  search() { git ls-files -z -co --exclude-standard -- . ':!scripts/privacy-check.sh' | xargs -0 grep -nIE "$1" 2>/dev/null; }
fi

section() { echo; echo "== $1"; }

section "UUIDs (fixtures use synthetic ones like a0000000-0000-4000-8000-…)"
search '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
  | grep -vE '[0-9a-z]0000000-0000-4000-8000-0000000000[0-9]{2}|00000000-0000-4000-8000-\$\{' || echo "(only synthetic)"

section "emails"
search '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | grep -vE 'noreply@anthropic\.com|@users\.noreply\.github\.com|@example\.(com|org)' || echo "(none)"

section "local paths"
search '/Users/[A-Za-z]|/home/[a-z]+/|/private/(tmp|var)/|C:\\\\Users\\\\' | grep -v '/Users/Shared/' || echo "(none)"

section "keys / tokens"
search 'sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY' || echo "(none)"

section "real ChatGPT links / file ids"
search 'chatgpt\.com/(c|share)/[0-9a-f-]{8,}|file-[A-Za-z0-9]{20,}' || echo "(none)"

section "Chinese sentences outside docs/ and reports/ (rough match) — check by eye that none is real"
search '[一-龥，。、？！：；（）「」“”]{40,}' | grep -vE '^(\S+:)?(docs|reports)/' || echo "(none)"
