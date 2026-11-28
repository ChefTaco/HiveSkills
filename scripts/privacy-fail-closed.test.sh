#!/usr/bin/env bash
# Regression test: scripts/check-private-data.sh and the pre-push hook fail closed.
#
# A large input (a new branch's whole history, or a long commit message) that contains a
# private term must fail. The check once piped `grep -v` into `grep -q`; under pipefail the
# early exit of `grep -q` turned a match on a large input into SIGPIPE (exit 141), which the
# check read as "no match". A clean large input must pass, and a commit that only removes a
# term that is already published must be pushable without bypassing the hooks. Also covered:
# message lines starting with #, non-ASCII file names, per-line pattern validation, unreadable
# or CRLF denylists, file names kept out of error output, and which remote counts as published.
#
# Uses only a fake term from a test-only terms file, in disposable repositories.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Hooks pass Git environment variables; never let fixtures touch the caller's repository.
for variable in $(git rev-parse --local-env-vars); do unset "$variable"; done

failures=0
problem() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}
# Runs a command, storing its combined output in $WORK/out and its exit status in $status.
run() {
  status=0
  "$@" > "$WORK/out" 2>&1 || status=$?
}
expect_status() {
  [[ "$status" -eq "$1" ]] || problem "$2: exit status $status, expected $1"
  if grep -qiF planted "$WORK/out"; then problem "$2: output contains the planted term"; fi
}

# The fake term is assembled at run time so this file never contains it literally.
TERM_VALUE="zq$(printf 'x%.0s' 1 2)planted$((40 + 2))"
FILLER='filler line of a long commit history that holds no private names at all'
# 50 MB of filler. Process substitution, not a pipe: `yes` ends on SIGPIPE by design.
filler() { head -c 50000000 < <(yes "$FILLER"); }

mkdir -p "$WORK/repo/scripts" "$WORK/repo/.githooks"
cp "$ROOT_DIR/scripts/check-private-data.sh" "$WORK/repo/scripts/"
cp "$ROOT_DIR/.githooks/pre-push" "$WORK/repo/.githooks/"
# The secret scanner is tested elsewhere; here it only has to consume the push input.
printf '#!/usr/bin/env bash\ncat > /dev/null\n' > "$WORK/repo/scripts/gitleaks.sh"
cd "$WORK/repo"
git init -q -b main
git config user.name 'Privacy Fixture'
git config user.email 'fixture@example.com'
git config core.hooksPath /dev/null
printf '%s\n' '.private-terms' > .gitignore
printf '%s\n' '# test-only denylist' 'zqx+planted[0-9]+' > .private-terms
# The hook compares new branches with the tracking branches of the remote it pushes to.
git remote add origin "file://$WORK/remote.git"

# --- large commit-message input ----------------------------------------------------------
{ printf 'fix: name %s\n\n' "$TERM_VALUE"; filler; } > "$WORK/large-dirty"
run bash scripts/check-private-data.sh --message "$WORK/large-dirty"
expect_status 1 "50 MB message with a term on its first line"
{ filler; printf '\nfix: name %s\n' "$TERM_VALUE"; } > "$WORK/large-dirty-end"
run bash scripts/check-private-data.sh --message "$WORK/large-dirty-end"
expect_status 1 "50 MB message with a term on its last line"
filler > "$WORK/large-clean"
run bash scripts/check-private-data.sh --message "$WORK/large-clean"
expect_status 0 "clean 50 MB message"
run bash scripts/check-private-data.sh --message "$WORK/missing-message"
expect_status 2 "missing message file"
# git keeps lines starting with # in `git commit -m` messages, so they are checked too.
printf 'fix: tidy\n\n# host %s\n' "$TERM_VALUE" > "$WORK/comment-line"
run bash scripts/check-private-data.sh --message "$WORK/comment-line"
expect_status 1 "message whose term is on a line starting with #"

# --- pre-push over many commits ------------------------------------------------------------
# Builds $2 commits on branch $1 with fast-import; commit number $3 (0 for none) names the term.
many_commits() {
  local branch="$1" count="$2" dirty="$3" i message
  {
    for ((i = 1; i <= count; i++)); do
      message="chore: commit $i $FILLER"
      [[ "$i" -ne "$dirty" ]] || message="fix: name $TERM_VALUE"
      printf 'commit refs/heads/%s\ncommitter Privacy Fixture <fixture@example.com> %d +0000\n' "$branch" "$((1700000000 + i))"
      printf 'data %d\n%s\n' "$((${#message} + 1))" "$message"
      [[ "$i" -ne 1 ]] || printf 'M 644 inline clean.txt\ndata 6\nclean\n'
      printf '\n'
    done
  } | git fast-import --quiet
}
zero=0000000000000000000000000000000000000000
push() { # push <branch> [remote]: runs the pre-push hook for a new branch, as `git push` would
  printf 'refs/heads/%s %s refs/heads/%s %s\n' "$1" "$(git rev-parse "$1")" "$1" "$zero" > "$WORK/push"
  git checkout -q -f "$1"
  run bash .githooks/pre-push "${2:-origin}" "file://$WORK/remote.git" < "$WORK/push"
}

many_commits dirty 3000 3000
push dirty
expect_status 1 "new branch of 3000 commits whose newest message names a term"
many_commits clean 3000 0
many_commits middle 3000 1500
push middle
expect_status 1 "new branch of 3000 commits with a term in the middle of its history"
push clean
expect_status 0 "new branch of 3000 clean commits"

# --- removing a published term -------------------------------------------------------------
# main already carries a term (in a file and a message) on the remote; a branch that only
# removes it must pass the staged check and the pre-push hook.
git checkout -q -f clean
git checkout -q -b main-leak
printf 'first line\nhost %s\n' "$TERM_VALUE" > notes.txt
git add notes.txt
git commit -qm "docs: name $TERM_VALUE"
git update-ref refs/remotes/origin/main HEAD
git checkout -q -b removal
printf 'first line\nhost example.com\n' > notes.txt
git add notes.txt
run bash scripts/check-private-data.sh --staged
expect_status 0 "staged check of a change that only removes a term"
git commit -qm 'docs: genericize a host name'
push removal
expect_status 0 "pre-push of a branch that only removes a published term"
# Pushing to a URL rather than a configured remote has no published history to skip.
push removal "file://$WORK/remote.git"
expect_status 1 "pre-push to an unconfigured URL checks the whole history"

# Only the push target's tracking branches count as published: a commit that sits on another
# remote's (possibly stale) tracking branch is still outgoing for origin.
git checkout -q -b elsewhere removal
printf 'other\n' > other.txt
git add other.txt
git commit -qm "docs: name $TERM_VALUE"
git remote add other "file://$WORK/other.git"
git update-ref refs/remotes/other/elsewhere HEAD
git checkout -q -b on-top elsewhere
printf 'more\n' >> other.txt
git add other.txt
git commit -qm 'docs: more'
push on-top
expect_status 1 "pre-push of a branch whose term is only on another remote's tracking branch"

git checkout -q -b hash-line removal
git commit -q --allow-empty -m 'fix: tidy' -m "# host $TERM_VALUE"
push hash-line
expect_status 1 "pre-push of a commit whose message names a term on a line starting with #"

# A hook that also reviews outgoing patches must still catch a term that a branch adds and
# later removes, because the term would stay in the pushed history.
if grep -qF -- '--patch' .githooks/pre-push; then
  git checkout -q -b add-then-remove removal
  printf 'first line\nhost %s\n' "$TERM_VALUE" > notes.txt
  git add notes.txt
  git commit -qm 'docs: add a host'
  printf 'first line\nhost example.com\n' > notes.txt
  git add notes.txt
  git commit -qm 'docs: genericize a host name again'
  push add-then-remove
  expect_status 1 "pre-push of a branch whose history adds a term"
  # Color codes or "Binary files differ" must not hide the added lines from the review.
  git config color.ui always
  push add-then-remove
  expect_status 1 "pre-push of a branch whose history adds a term, with color.ui=always"
  git config --unset color.ui
  git checkout -q -b binary-add removal
  printf '*.txt -diff\n' > .gitattributes
  printf 'host %s\n' "$TERM_VALUE" > binary.txt
  git add .gitattributes binary.txt
  git commit -qm 'docs: add a host'
  git rm -q binary.txt
  git commit -qm 'docs: drop the host'
  push binary-add
  expect_status 1 "pre-push of a branch whose history adds a term in a -diff file"
fi

# --- file names and denylist handling (a fresh repository) ---------------------------------
fresh() {
  cd "$WORK"
  rm -rf "$WORK/fresh"
  mkdir -p "$WORK/fresh/scripts"
  cp "$ROOT_DIR/scripts/check-private-data.sh" "$WORK/fresh/scripts/"
  cd "$WORK/fresh"
  git init -q -b main
  git config core.hooksPath /dev/null
  printf '%s\n' '.private-terms' > .gitignore
  printf '%s\n' 'zqx+planted[0-9]+' > .private-terms
  git add .gitignore scripts/check-private-data.sh
}
# Non-ASCII names are quoted by git unless listed with -z; they must still be checked.
fresh
printf 'host %s\n' "$TERM_VALUE" > "$(printf 'notes-\303\274.txt')"
git add -A
run bash scripts/check-private-data.sh
expect_status 1 "tracked file with a non-ASCII name that holds a term"
run bash scripts/check-private-data.sh --staged
expect_status 1 "staged file with a non-ASCII name that holds a term"
fresh
mkdir "$(printf '\303\274')"
printf 'clean\n' > "$(printf '\303\274')/.env"
git add -A
run bash scripts/check-private-data.sh --staged
expect_status 1 "forbidden file under a non-ASCII directory"

# Denylist lines with Windows line endings still match.
fresh
printf 'zqx+planted[0-9]+\r\n' > .private-terms
printf 'host %s\n' "$TERM_VALUE" > notes.txt
git add notes.txt
run bash scripts/check-private-data.sh --staged
expect_status 1 "denylist with CRLF line endings"

# Each line is validated on its own: these two are invalid alone but valid once joined.
fresh
printf '%s\n' 'zz(' ')zz' > .private-terms
run bash scripts/check-private-data.sh
expect_status 2 "denylist lines that are only valid when joined"

# A denylist that exists but is not a readable file stops the check.
fresh
rm .private-terms
mkdir .private-terms
run bash scripts/check-private-data.sh
expect_status 2 "denylist path that is a directory"
fresh
rm .private-terms
ln -s "$WORK/no-such-terms" .private-terms
run bash scripts/check-private-data.sh
expect_status 2 "denylist path that is a dangling symlink"

if [[ "$(id -u)" -ne 0 ]]; then
  fresh
  chmod 000 .private-terms
  run bash scripts/check-private-data.sh
  expect_status 2 "unreadable denylist"
  # grep's own error would name the file; the check reports it without the name.
  fresh
  printf 'clean\n' > "docs-$TERM_VALUE.txt"
  git add -A
  chmod 000 "docs-$TERM_VALUE.txt"
  run bash scripts/check-private-data.sh
  expect_status 2 "unreadable tracked file whose name holds a term"
  chmod 644 "docs-$TERM_VALUE.txt"
fi

cd "$ROOT_DIR"
if [[ "$failures" -gt 0 ]]; then
  echo "privacy fail-closed test failed with $failures problem(s)." >&2
  exit 1
fi
echo "Privacy fail-closed test passed."
