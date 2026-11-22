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
# jlapenna/messages-control#135). The copy is a self-contained CLI that serves
# guides from its own directory, so every text file in it is rewritten to run
# that copied, lockfile-pinned CLI with DISABLE_TELEMETRY=1, and SKILL.md's
# npx/pnpx/network advice is replaced. The sync fails closed if an unpinned
# invocation survives. To opt in to telemetry, run the CLI without
# DISABLE_TELEMETRY.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

package=modern-web-guidance
skills=(modern-web-guidance chrome-extensions)

launcher='"$(git rev-parse --show-toplevel)/.agents/skills/modern-web-guidance/modern-web.mjs"'
pinned_cli="DISABLE_TELEMETRY=1 node $launcher"
# Bundled JavaScript gets escaped quotes (\"), which every JS string form
# reads as a plain double quote, so printed commands keep the path quoted.
pinned_cli_js='DISABLE_TELEMETRY=1 node \\"$(git rev-parse --show-toplevel)/.agents/skills/modern-web-guidance/modern-web.mjs\\"'
runner_re='(npx( -y| --yes)?|pnpx|pnpm (dlx|exec)|bunx|yarn dlx) modern-web-guidance(@[A-Za-z0-9._-]+)?'
# npm dist tags and versions; Claude plugin IDs in the CLI's help text, such
# as modern-web-guidance@googlechrome, are not npm specs.
unpinned_re='modern-web-guidance@(latest|next|beta|canary|[0-9^~])'

fail() {
  echo "sync-package-skills: $*" >&2
  rm -rf node_modules/.sync-package-skills
  exit 1
}

# Clear every managed copy before validating any source, so a failed or
# partial sync never leaves an older skill discoverable.
for skill in "${skills[@]}"; do
  rm -rf ".agents/skills/$skill"
done

# Without the package (for example a production install that omits
# devDependencies) the skills are simply absent.
[ -d "node_modules/$package" ] || exit 0

for skill in "${skills[@]}"; do
  [ -f "node_modules/$package/skills/$skill/SKILL.md" ] ||
    fail "$package no longer ships skills/$skill; update tools/sync-package-skills.sh"
done

pin_runner_section() {
  local skill_md="$1" tmp="$1.tmp"
  awk -v cli="$pinned_cli" '
    /^## Using npx \/ pnpx$/ {
      print "## Running the pinned CLI"
      print ""
      print "- This copy was installed by `tools/sync-package-skills.sh` from the lockfile-pinned `modern-web-guidance` devDependency. Run it only as `" cli " ...`. It works offline; do not request network access for it."
      print "- Never run `modern-web-guidance` through a package runner or download it, and do not update it yourself: Renovate bumps the pinned version."
      print "- If the file is missing, the local CLI is unavailable. Follow the repository development skill on whether installing dependencies is in scope; otherwise report the CLI as unavailable. Never fetch the package instead."
      print "- Telemetry is disabled with `DISABLE_TELEMETRY=1`; keep it set."
      skipping = 1
      replaced = 1
      next
    }
    skipping && /^## / { skipping = 0; print "" }
    !skipping { print }
    END { if (!replaced) exit 3 }
  ' "$skill_md" >"$tmp" || fail "$skill_md has no '## Using npx / pnpx' section to replace; update tools/sync-package-skills.sh"
  mv "$tmp" "$skill_md"
  sed -i 's/directly with `npx` using/using/' "$skill_md"
  if grep -qwE 'npx|pnpx|bunx|dlx' "$skill_md"; then
    fail "$skill_md still recommends a package runner; extend the rewrite"
  fi
}

# Stage, rewrite and validate every copy before exposing any of them, so a
# rejected package never leaves a skill in the discovery directories.
staging="node_modules/.sync-package-skills"
rm -rf "$staging"
mkdir -p "$staging"
for skill in "${skills[@]}"; do
  dest="$staging/$skill"
  cp -RL "node_modules/$package/skills/$skill" "$dest"
  # -I skips binary files; -Z/-0 keep unusual file names intact; no match is
  # not an error.
  { grep -rlIZE --exclude='*.mjs' --exclude='*.js' "$runner_re" "$dest" || true; } |
    xargs -0 -r sed -i -E "s#$runner_re#$pinned_cli#g"
  { grep -rlIZE --include='*.mjs' --include='*.js' "$runner_re" "$dest" || true; } |
    xargs -0 -r sed -i -E "s#$runner_re#$pinned_cli_js#g"
  if [ "$skill" = "$package" ]; then
    pin_runner_section "$dest/SKILL.md"
  fi
  if grep -rqE "$runner_re|$unpinned_re" "$dest"; then
    grep -rnE "$runner_re|$unpinned_re" "$dest" | head -5 >&2
    rm -rf "$staging"
    fail "$skill still runs an unpinned $package"
  fi
done
mkdir -p .agents/skills
for skill in "${skills[@]}"; do
  mv "$staging/$skill" ".agents/skills/$skill"
done
rm -rf "$staging"
