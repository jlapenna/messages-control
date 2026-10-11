#!/usr/bin/env bash
# Initialize a linked worktree without changing the primary checkout.
#
# Idempotent: safe to rerun as a repair after a dependency or hook change.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Linked-worktree guard, the same prelude the other fleet repos carry. The
# primary checkout is reserved for a clean main; this script is the wrong tool
# there.
git_dir="$(git rev-parse --path-format=absolute --git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
if [ "$git_dir" = "$common_dir" ]; then
  echo "ERROR: tools/setup-worktree.sh must run in a linked feature worktree." >&2
  exit 1
fi

echo "==> Installing dependencies"
npm ci

# Every worktree has its own ignored .husky/_ bootstrap directory. npm ci runs
# `prepare` (husky) unless lifecycle scripts are disabled (ignore-scripts, or
# an inherited HUSKY=0 makes husky a no-op), so regenerate explicitly rather
# than trusting the install to have done it.
echo "==> Regenerating git hooks"
env -u HUSKY npx --no-install husky

# `husky` points the shared core.hooksPath at .husky/_. When the repo-tools
# package is installed, hand it back to the common-dir bootstrap so worktrees
# made by a bare `git worktree add` (no install yet) still run their tracked
# hooks. Guarded with command -v like the hooks themselves.
if command -v repo-install-husky-hooks >/dev/null 2>&1; then
  repo-install-husky-hooks
fi

if [ ! -f .husky/_/h ]; then
  echo "ERROR: husky did not generate .husky/_/h." >&2
  exit 1
fi
for hook_type in pre-commit pre-push; do
  hook="$(git rev-parse --path-format=absolute --git-path "hooks/$hook_type")"
  if [ ! -x "$hook" ]; then
    echo "ERROR: missing executable git hook $hook." >&2
    exit 1
  fi
done

# No local env/config copy step: .gitignore lists only build output and
# node_modules, so there is nothing gitignored to share from the primary
# checkout.

echo "==> Worktree ready."
