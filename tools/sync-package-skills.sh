#!/usr/bin/env bash
# Install agent skills that ship inside pinned npm devDependencies into
# .agents/skills (the copies are gitignored and dockerignored). package.json
# pins each package and Renovate bumps it, so the installed skill always
# matches the lockfile without a vendored copy or a symlink that dangles
# before install. Runs from postinstall.
#
# Pinning: modern-web-guidance's SKILL.md and guides tell agents to run
# `npx -y modern-web-guidance@latest`, which executes whatever npm's latest
# tag points at before Renovate, CI and review qualify it, and its CLI sends
# search queries and agent details to Google by default (LCARS review of
# jlapenna/messages-control#135). Every text file in each copy is rewritten
# to run the copied, lockfile-pinned CLI with DISABLE_TELEMETRY=1; `retrieve`
# serves guides from the copy, so retrieved cross-references are pinned too.
# The sync fails if any unpinned invocation survives. To opt in to telemetry,
# run the CLI yourself without DISABLE_TELEMETRY.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pinned_cli='DISABLE_TELEMETRY=1 node "$(git rev-parse --show-toplevel)/.agents/skills/modern-web-guidance/modern-web.mjs"'
unpinned_re='modern-web-guidance@(latest|next|beta|canary|[0-9^~])'
pinned_cli_js='DISABLE_TELEMETRY=1 node $(git rev-parse --show-toplevel)/.agents/skills/modern-web-guidance/modern-web.mjs'
runner_re='(npx( -y| --yes)?|pnpx|pnpm (dlx|exec)|bunx|yarn dlx) modern-web-guidance(@[A-Za-z0-9._-]+)?'

# <package> <skill directory under the package's skills/>
sync_skill() {
  local pkg="node_modules/$1" src="node_modules/$1/skills/$2" dest=".agents/skills/$2"
  rm -rf "$dest"
  # Without the package (for example a production install that omits
  # devDependencies) the skill is simply absent, never a stale copy.
  [ -d "$pkg" ] || return 0
  if [ ! -f "$src/SKILL.md" ]; then
    echo "sync-package-skills: $1 no longer ships skills/$2; update tools/sync-package-skills.sh" >&2
    exit 1
  fi
  mkdir -p .agents/skills
  cp -RL "$src" "$dest"
  # -I skips binary files; -Z/-0 keep unusual file names intact (no match is
  # not an error). Bundled
  # JavaScript gets the quote-free form so its string literals stay valid.
  { grep -rlIZE --exclude='*.mjs' --exclude='*.js' "$runner_re" "$dest" || true; } |
    xargs -0 -r sed -i -E "s#$runner_re#$pinned_cli#g"
  { grep -rlIZE --include='*.mjs' --include='*.js' "$runner_re" "$dest" || true; } |
    xargs -0 -r sed -i -E "s#$runner_re#$pinned_cli_js#g"
  # Fail closed on any surviving npm runner or registry spec (dist tag or
  # version). Claude plugin IDs such as modern-web-guidance@googlechrome in
  # the CLI's help text are not npm specs.
  if grep -rqE "$runner_re|$unpinned_re" "$dest"; then
    echo "sync-package-skills: $dest still runs an unpinned modern-web-guidance:" >&2
    grep -rnE "$runner_re|$unpinned_re" "$dest" | head -5 >&2
    exit 1
  fi
}

sync_skill modern-web-guidance modern-web-guidance
sync_skill modern-web-guidance chrome-extensions
