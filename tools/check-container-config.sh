#!/usr/bin/env bash
# Release gate: settings and private permissions survive a fresh container.
set -euo pipefail
image="${1:?usage: check-container-config.sh IMAGE}"
volume="$(docker volume create)"
trap 'docker volume rm "$volume" >/dev/null' EXIT
docker run --rm -v "$volume:/data" --entrypoint node "$image" --input-type=module -e '
  import assert from "node:assert/strict";
  import { CONFIG_FILE, writeConfig } from "./src/config.js";
  assert.equal(CONFIG_FILE, "/data/config.json");
  writeConfig({ endpoint: "https://fixture.invalid/v1/chat/completions", apiKey: "fixture-only", mode: "spam" });
'
docker run --rm -v "$volume:/data" --entrypoint node "$image" --input-type=module -e '
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import { CONFIG_FILE, readConfig, loadSettings } from "./src/config.js";
  assert.equal(readConfig().apiKey, "fixture-only");
  assert.equal(loadSettings().endpoint, "https://fixture.invalid/v1/chat/completions");
  assert.equal(fs.statSync(CONFIG_FILE).mode & 0o777, 0o600);
  console.log("Container configuration persists with owner-only permissions.");
'
