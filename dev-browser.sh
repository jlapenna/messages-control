#!/bin/sh
# Dev browser: Chromium in WSL (shown on the Windows desktop through WSLg)
# with this extension loaded from the repo and DevTools on loopback port
# 9333, so an agent can reload the extension and inspect the real Messages
# page. The profile persists, so Messages pairing (QR scan) is needed once.
# HEADLESS=1 runs without a window (pair by screenshotting the QR code over
# DevTools); use it when WSLg has no working display.
set -eu
repo=$(cd "$(dirname "$0")" && pwd)
chrome=$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
[ -x "$chrome" ] || { echo "No Playwright Chromium found under ~/.cache/ms-playwright" >&2; exit 1; }
export DISPLAY="${DISPLAY:-:0}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/mnt/wslg/runtime-dir}"
headless=
[ "${HEADLESS:-}" = 1 ] && headless="--headless=new --window-size=1400,1000"
# Headless Chromium advertises itself in its user agent; Messages may refuse it.
ua="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
# shellcheck disable=SC2086
exec "$chrome" $headless --user-agent="$ua" \
  --user-data-dir="$HOME/.config/messages-spam-filter-chromium" \
  --remote-debugging-port=9333 \
  --enable-unsafe-extension-debugging \
  --load-extension="$repo" \
  --no-first-run --no-default-browser-check \
  https://messages.google.com/web/conversations
