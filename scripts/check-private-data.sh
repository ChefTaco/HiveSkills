#!/usr/bin/env bash
# Blocks private data from entering git history.
#
#   check-private-data.sh --staged        check files staged for commit (pre-commit hook)
#   check-private-data.sh --message FILE  check a commit message (commit-msg hook)
#   check-private-data.sh                 check every tracked file (CI and manual use)
#
# Two layers:
#   1. Forbidden paths: env files, keys, certificates, databases, backups, and
#      private agent notes (*.local.md) may never be committed.
#   2. Private terms: an optional, gitignored `.private-terms` file at the repo
#      root lists one extended regex per line (case-insensitive) for names that
#      must never appear in the repo or in commit messages, such as personal
#      hostnames, private network domains, usernames, or private project names.
#      Lines starting with # and blank lines are ignored. The file is local so
#      the denylist itself never becomes public.
#
# Findings print only the path, line number and rule, never the matching text,
# so a failing CI run cannot copy a private term into its public log. A path
# that itself contains a private term is printed as "(path redacted)".
#
# Commit messages are checked in full, lines starting with # included (git keeps them with -m).
# A commit-msg run on `git commit -v` therefore also checks the diff below the scissors line.
#
# Known limits: pushed history is reviewed by its commit messages (and, where the pre-push hook
# reads patches, by added lines); merge resolutions without a patch and annotated tag messages
# are not reviewed. The tracked check reads the working tree, not the pushed commit. A term
# split across lines is not found, and case folding of non-ASCII letters follows the locale
# (none under LC_ALL=C).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MODE="tracked"
MESSAGE_FILE=""
case "${1:-}" in
  --staged) MODE="staged" ;;
  --message) MODE="message"; MESSAGE_FILE="${2:?--message requires a file}" ;;
  "") ;;
  *) echo "usage: $0 [--staged | --message FILE]" >&2; exit 2 ;;
esac

TERMS_FILE="$ROOT_DIR/.private-terms"
# Scratch space for the denylist, file lists, staged blobs and search results; removed on exit.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

TERMS_PATTERN=""
if [[ -e "$TERMS_FILE" || -L "$TERMS_FILE" ]]; then
  # A denylist that exists but cannot be read (a directory, a dangling link, no permission)
  # stops the check instead of being skipped.
  if [[ ! -f "$TERMS_FILE" || ! -r "$TERMS_FILE" ]]; then
    echo 'private-data check: cannot read .private-terms' >&2
    exit 2
  fi
  # Carriage returns (Windows line endings) would make every pattern require one.
  tr -d '\r' < "$TERMS_FILE" > "$scratch/terms" || { echo 'private-data check: cannot read .private-terms' >&2; exit 2; }
  terms_status=0
  grep -vE '^[[:space:]]*(#|$)' -- "$scratch/terms" > "$scratch/patterns" || terms_status=$?
  if [[ "$terms_status" -gt 1 ]]; then
    echo 'private-data check: cannot read .private-terms' >&2
    exit 2
  fi
  # Every line must be a valid pattern on its own (two broken lines can join into a valid one),
  # and so must the joined pattern: grep reports a broken pattern as "no match" everywhere.
  while IFS= read -r pattern; do
    if grep -qiE -- "$pattern" </dev/null 2>/dev/null; then :
    elif [[ "$?" -gt 1 ]]; then
      echo 'private-data check: invalid regular expression in .private-terms' >&2
      exit 2
    fi
  done < "$scratch/patterns"
  TERMS_PATTERN="$(paste -sd '|' "$scratch/patterns")"
  if [[ -n "$TERMS_PATTERN" ]]; then
    if grep -qiE -- "$TERMS_PATTERN" </dev/null 2>/dev/null; then :
    elif [[ "$?" -gt 1 ]]; then
      echo 'private-data check: invalid regular expression in .private-terms' >&2
      exit 2
    fi
  fi
fi

FORBIDDEN_PATHS='(^|/)\.env($|\.)|(^|/)\.npmrc$|\.(pem|key|crt|p12|pfx|db|sqlite|sqlite3|bundle)$|(^|/)certs/|(^|/)backups/|(^|/)\.hive-dev/|(^|/)[^/]+\.local\.md$|(^|/)\.private-terms$|(^|/)\.vscode/mcp\.json$'
ALLOWED_PATHS='\.env\.example$'

failures=0
fail() {
  printf 'private-data check: %s\n' "$1" >&2
  failures=$((failures + 1))
}
shown() {
  local status=0
  if [[ -z "$TERMS_PATTERN" ]]; then printf '%s' "$1"; return; fi
  grep -qiE -- "$TERMS_PATTERN" <<< "$1" 2>/dev/null || status=$?
  if [[ "$status" -eq 1 ]]; then printf '%s' "$1"; else printf '(path redacted)'; fi
}

# Prints the numbers of the lines in file $1 that contain a private term. grep reads the whole
# file into a file of its own (no -q early exit and no pipe, where under pipefail an early exit
# can surface as SIGPIPE, exit 141, and pass as "no match"), and any grep error stops the check
# with a generic message: grep's own message would name the file, which may hold a term.
term_lines() {
  local status=0
  grep -naiE -- "$TERMS_PATTERN" "$1" > "$scratch/hits" 2>/dev/null || status=$?
  case "$status" in
    0) cut -d: -f1 -- "$scratch/hits" ;;
    1) ;;
    *) echo 'private-data check: unreadable tracked file (its name is not shown)' >&2; exit 2 ;;
  esac
}

if [[ "$MODE" == "message" ]]; then
  if [[ -n "$TERMS_PATTERN" ]]; then
    if [[ ! -f "$MESSAGE_FILE" || ! -r "$MESSAGE_FILE" ]]; then
      echo 'private-data check: could not read the commit message file' >&2
      exit 2
    fi
    message_lines="$(term_lines "$MESSAGE_FILE")"
    if [[ -n "$message_lines" ]]; then
      fail "commit message contains a term listed in .private-terms"
    fi
  fi
  [[ "$failures" -eq 0 ]] || exit 1
  exit 0
fi

if [[ "$MODE" == "staged" ]]; then
  git diff --cached --name-only --diff-filter=ACMR -z > "$scratch/files" || { echo 'private-data check: could not list staged files' >&2; exit 2; }
else
  git ls-files -z > "$scratch/files" || { echo 'private-data check: could not list tracked files' >&2; exit 2; }
fi
mapfile -d '' -t files < "$scratch/files"

for file in "${files[@]}"; do
  [[ -n "$file" ]] || continue
  if [[ "$file" =~ $FORBIDDEN_PATHS && ! "$file" =~ $ALLOWED_PATHS ]]; then
    fail "$(shown "$file"): forbidden file"
  fi
done

if [[ -n "$TERMS_PATTERN" && "${#files[@]}" -gt 0 ]]; then
  index_file="$scratch/index"
  for file in "${files[@]}"; do
    [[ -n "$file" ]] || continue
    if [[ "$MODE" == "staged" ]]; then
      git show ":$file" > "$index_file" 2>/dev/null || { echo 'private-data check: unreadable staged file (its name is not shown)' >&2; exit 2; }
      content_file="$index_file"
    else
      [[ -f "$file" ]] || continue
      content_file="$file"
    fi
    display="$(shown "$file")"
    # A plain assignment, so a search error (exit 2 from term_lines) stops the check.
    content_lines="$(term_lines "$content_file")"
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      fail "$display:$line: private term"
    done <<< "$content_lines"
    if [[ "$display" != "$file" ]]; then
      fail "$display: private term in file name"
    fi
  done
fi

if [[ "$failures" -gt 0 ]]; then
  echo "private-data check failed with $failures finding(s). Remove the data, or genericize it (example.com hosts, env vars)." >&2
  exit 1
fi
echo "Private data check passed."
