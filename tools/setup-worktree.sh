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

# `husky` points the shared core.hooksPath at .husky/_. Hand it back to the
# common-dir bootstrap so worktrees made by a bare `git worktree add` (no
# install yet) still run their tracked hooks. @jlapenna/repo-tools is a
# devDependency; use its public command.
npx --no-install repo-install-husky-hooks

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

# Agent sessions commit as the fleet identity, not the maintainer. An
# interactive Claude/Codex session runs git under the maintainer's global
# ~/.gitconfig, so without this every agent commit is authored "Joe LaPenna"
# and is indistinguishable from a hand-written one in git log, git blame, and
# the squash commit that lands on main. Worktrees are the seam: agent git work
# is required to happen in one and the primary checkout is reserved for a clean
# main, so scoping the identity here separates the two without touching any
# global config, credential, or anything that needs rotating.
#
# --worktree is load-bearing. A bare `git config user.email` in a linked
# worktree writes to $GIT_COMMON_DIR/config, which would rename the
# maintainer's own commits in the primary checkout and every sibling worktree.
#
# The gate keeps a human who makes a worktree by hand committing as themselves;
# these are the same variables `lcars session title` reads to identify a
# session. The address is GitHub's canonical {id}+{login} noreply form, so the
# commits link to the agent-lcars-bot account.
if [ -n "${CLAUDE_CODE_SESSION_ID:-}${CODEX_THREAD_ID:-}" ]; then
  echo "==> Attributing commits to agent-lcars-bot"
  git config extensions.worktreeConfig true
  git config --worktree user.name "agent-lcars-bot"
  git config --worktree user.email "317675255+agent-lcars-bot@users.noreply.github.com"
fi

echo "==> Worktree ready."
