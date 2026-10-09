# Messages Control

Watches messages.google.com/web. Each new thread is sent to
`llm.jlapenna.net` (LiteLLM, model `default`) for classification; spam is
blocked or trashed, one-time codes and automated notices are labelled and
archived once they're stale.

It runs on its own: a Node program drives a headless Chromium with its own
pairing to the phone. The same page-side code also loads as a Chrome
extension (see below) for poking at it with a side panel.

## Standalone

```sh
npm install
npx playwright install chromium        # add --with-deps on a bare server
export LITELLM_API_KEY=$(secrets-get LITELLM_API_KEY)
node bin/messages-control.js pair      # prints the QR; scan it with the phone
node bin/messages-control.js run       # watches; dry run until --live
```

`npm link` (or `npm install -g .`) puts `messages-control` on the PATH.

Pairing: on the phone, Messages → ⋮ → Device pairing → QR code scanner, and
scan the QR in the terminal (a copy is written to the state dir as
`qr.png`). The pairing lives in the browser profile under
`~/.local/state/messages-control/`, with "Remember this computer" switched
on, so it survives restarts. To unpair, delete that `profile` directory.
Google's "sign in with your Google account" route is not used: it wants a
CAPTCHA from an automated browser.

Commands (`--help` for the list): `run` watches, `pair` pairs and exits,
`sweep` is the extension's "Process all messages" (label everything, archive
old codes and notices, act on spam unless dry run), `diagnose` prints what
the page driver can see, `test-classifier` sends a sample text to the LLM.
`--headed` shows the browser window; `--live` turns dry run off.

Settings: `~/.config/messages-control/config.json` overrides the defaults in
`settings.js` (`apiKey`, `endpoint`, `model`, `threshold`, `spamAction`,
`skipNamedContacts`, `openPictureThreads`, `archiveOldNotices`, `topN`,
`prompt`). `LITELLM_API_KEY` in the environment sets `apiKey`.

The first scan loads the whole list and marks existing threads as seen; only
threads that arrive after that are candidates for deletion. It starts in
**dry run**: spam is logged, not deleted. Add `--live` once the log looks
right.

### As a service

```ini
# ~/.config/systemd/user/messages-control.service
[Unit]
Description=Messages Control
After=network-online.target

[Service]
EnvironmentFile=%h/.config/messages-control/env   # LITELLM_API_KEY=...
ExecStart=/usr/bin/env node %h/p/messages-control/bin/messages-control.js run --live
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

`journalctl --user -fu messages-control` shows the log. Pair first, in a
terminal.

### Docker

The Playwright base image carries Chromium, so the image is the
self-contained unit (a single executable isn't practical: Chromium is 150 MB
and has to ship alongside whatever bundles the JavaScript).

```sh
docker build -t messages-control .
docker run -it -v messages-control:/data -e LITELLM_API_KEY messages-control pair
docker run -d  -v messages-control:/data -e LITELLM_API_KEY --restart unless-stopped messages-control run --live
```

## As a Chrome extension

chrome://extensions → Developer mode → Load unpacked → this directory, in a
Chrome that is already paired. Extension → Settings → paste the LiteLLM key
→ Save → Test classifier. The side panel shows the log and offers "Process
all messages", "Check pictures now" and Diagnose.

## Behaviour

Picture messages are opened so the model can see the picture. Opening marks
a thread read, which sends an RCS read receipt if those are on;
`openPictureThreads: false` turns it off. In the extension, existing picture
threads are only opened while the Messages tab is in the background;
standalone owns its tab and opens them any time.

Automated notice-only texts (order ready, delivered, driver arriving, work
finished) get a "Notice" label; event invites such as Partiful don't.
One-time codes are archived after 6 hours and notices after a day (by the
earliest the latest message could have arrived); archiving keeps the
conversation and isn't blocked by dry run, which only forbids trashing.

## Layout

- `messages-dom.js`: Google Messages DOM driver (list, delete, diagnose). No
  `chrome.*` APIs.
- `content.js`: new-thread detection and the classify → delete policy. Uses
  `chrome.runtime.sendMessage` and `chrome.storage.local`.
- `src/page-shim.js`: the slice of `chrome.*` those two use, backed by the
  Node side. `src/cli.js` injects shim + driver + content.js into the page.
- `src/backend.js`: the LLM call and the log (what `background.js` does for
  the extension). `src/store.js`: `chrome.storage.local` on a JSON file.
  `src/pair.js`: QR pairing. `src/browser.js`: persistent Chromium profile.
- `background.js`, `panel.*`, `options.*`, `settings.js`: the extension's
  worker, UI and settings. `settings.js` holds the defaults for both.

## When Google changes the UI

Selectors in `messages-dom.js` are guesses with fallbacks.
`messages-control diagnose` (or the side panel's Diagnose) shows what
matched: the thread count, sample names and snippets, and whether the
per-thread menu button was found. `--headed` shows the page itself.

## Repository and harness maintenance

Start at the [agent guide](AGENTS.md) and
[messages-control-dev skill](.agents/skills/messages-control-dev/SKILL.md) for source ownership,
verification and delivery. The skill keeps this repository's operational
boundaries local and routes general harness upkeep to the shared workflow.
