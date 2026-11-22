#!/usr/bin/env bash
# Install agent skills that ship inside pinned npm devDependencies into
# .agents/skills (the copies are gitignored and dockerignored). package.json
# pins each package and Renovate bumps it, so the installed skill always
# matches the lockfile without a vendored copy or a symlink that dangles
# before install. Runs from postinstall.
#
# modern-web-guidance's upstream SKILL.md runs `npx -y modern-web-guidance@latest`,
# which would execute whatever npm's latest tag points at before Renovate and
# review qualify it, and its CLI sends search queries and agent details to
# Google by default. The copy is rewritten to run the lockfile-installed CLI
# (`npx --no-install`) with DISABLE_TELEMETRY=1. To opt in to telemetry, run
# the CLI yourself without that variable.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pinned_cli='DISABLE_TELEMETRY=1 npx --no-install modern-web-guidance'

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
  if [ "$1" = modern-web-guidance ]; then
    sed -i.bak \
      -e "s#npx -y modern-web-guidance@latest#$pinned_cli#g" \
      -e "s#pnpx modern-web-guidance@latest#$pinned_cli#g" \
      "$dest/SKILL.md"
    rm -f "$dest/SKILL.md.bak"
    if grep -q 'modern-web-guidance@latest' "$dest/SKILL.md"; then
      echo "sync-package-skills: $dest/SKILL.md still runs modern-web-guidance@latest; extend the rewrite" >&2
      exit 1
    fi
  fi
}

sync_skill modern-web-guidance modern-web-guidance
sync_skill modern-web-guidance chrome-extensions
