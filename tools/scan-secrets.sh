#!/usr/bin/env bash
# Required merge check: do not let event-specific diff selection skip an old
# credential that was added and then removed. Redact all scanner output.
set -euo pipefail
exec "${GITLEAKS_BIN:-gitleaks}" detect --source "${1:-.}" --log-opts=--all --redact
