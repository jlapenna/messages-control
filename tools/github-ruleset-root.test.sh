#!/usr/bin/env bash
# fleet-onboard: managed by jlapenna/agent-lcars tools/fleet-onboard.mjs. Re-run it to refresh; delete this line to own the file locally.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="$root/infra/github-ruleset/main.tf"

# The root must remain self-contained so fork pull requests can initialize and
# validate it without credentials or source from another fleet repository.
grep -Fqx '  owner = "jlapenna"' "$config"
grep -Fqx '  repository  = "messages-control"' "$config"
for context in \
  'gitleaks' \
  'validate / repository validation' \
  'repository-owned Terraform' \
  'test'; do
  grep -Fqx "        context = \"$context\"" "$config"
done
if grep -Fq 'source = "git::https://github.com/jlapenna/homelab.git' "$config"; then
  echo "github-ruleset root must not import Homelab source" >&2
  exit 1
fi

echo "repository-owned GitHub ruleset contract passed"
