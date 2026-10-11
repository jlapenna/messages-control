# Messages Control

Keeps a Google Messages inbox clean. A headless Chromium, paired with your
phone through messages.google.com/web, watches for new threads; each one is
classified by an LLM you point it at (any OpenAI-compatible endpoint), and:

- **spam** (scams, phishing, fake delivery/toll notices, political blasts,
  loan/crypto/job offers, wrong-number openers) is **blocked & reported**
  (reversible from Messages → Spam & blocked), or trashed if you prefer;
- **marketing** (a real store's sale, coupon, loyalty text) is **deleted**,
  never reported as spam;
- **transactional** texts (receipts, bills, appointments, shipments) are
  kept and listed in the daily digest with what the model extracted:
  summary, date, amount, confirmation or tracking number.

By default, automatic classification skips threads whose displayed name has
no digits or `@`. This is a heuristic, not an address-book lookup: a saved
contact with digits or an email address in its name is not protected by it.
It starts in **dry run**:
spam and marketing are logged, not blocked or trashed, until you pass
`--live`. Dry run does not hold back `full` mode's archiving of old codes and
notices, and opening a picture thread marks it read either way.

Two modes. `spam` (the default) does only the above, on new threads. `full`
also labels your history and archives one-time codes after 6 hours and
automated notices (order ready, delivered, driver arriving) after a day.
Review activity before enabling live actions. Classification can make mistakes;
blocks and archives are reversible, but deleted conversations are not.

## Install

The standalone CLI is tested with Node.js 24 on Linux. Pairing requires a
graphical desktop and an Android phone using Google Messages. This is an
experimental tool that drives the Messages web UI; selector changes can break
it. Start in spam mode and dry run, and inspect the outcomes before `--live`.

```sh
git clone https://github.com/jlapenna/messages-control && cd messages-control
npm install && npx playwright install chromium   # add --with-deps on a bare server
npm link                                          # puts `messages-control` on PATH
messages-control init                             # endpoint, model, API key, mode
messages-control pair --headed                    # sign in with the phone's Google account
messages-control run                              # dry run; add --live when the log looks right
```

Or Docker, where Chromium comes with the base image:

```sh
docker build -t messages-control .
docker run --rm -it -v messages-control:/data messages-control init
docker run -d --name messages-control -v messages-control:/data --restart unless-stopped messages-control run
```

The image stores both configuration (`/data/config.json`) and message state
in the volume. It contains API keys, private messages and the paired browser
profile; keep it private. To use an environment API key instead, pass
`-e MESSAGES_CONTROL_API_KEY` to each container that needs it.

Pairing needs a window: pair locally with `--state-dir /path/to/state`, then
copy that directory's contents into `/data` before starting the container.
Keep the volume's `config.json` from `init`; local configuration is stored
separately by default. Use dry run first; add `--live` only after reviewing
the log. The dashboard binds to container loopback by default; exposing it
requires configuring `api.bind`, allowed `api.hosts` and an authenticated
reverse proxy as described below.

## Chrome extension

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select this repository. Open the extension's options, set your endpoint,
model and API key, then click **Save**. Chrome asks for access to that endpoint's
host; denial leaves the previous settings unchanged. HTTP and HTTPS endpoints
are supported, including local gateways; use HTTPS for remote services.
Only Google Messages and its picture hosts are required permissions at
installation. Classifier access is requested for the selected host at runtime.
After updating an existing installation, click Save again if endpoint access
is missing. Pair Google Messages in the same Chrome profile before using it.

## Pairing

Google Messages for web pairs by signing in with the Google account the
phone uses: `pair --headed` opens a Chromium window, you sign in, approve on
the phone, done. The pairing lives in the browser profile under
`~/.local/state/messages-control/profile` and survives restarts. To unpair,
delete that directory. (The QR pairing route still exists at
`messages-control pair` without `--headed`, but recent Messages apps no
longer have a QR scanner.)

## Commands

| Command | What it does |
| --- | --- |
| `run` | watch and act on new threads (the default) |
| `scan` | one scan now; `--include-seen` treats the top 20 threads as new |
| `sweep` | "Process all messages": label the whole list, archive old codes and notices (full mode), act on spam and marketing unless dry run |
| `act-on-spam` | block/trash threads already labelled spam (`--live`) |
| `check-pictures` | open every pending picture thread and classify it |
| `diagnose` | what the page driver can see (thread count, menu found) |
| `log [--limit N]`, `clear-log` | the activity log |
| `status` | config, pairing, last scan, actions in the last 24 h, service state |
| `init`, `test-classifier` | write the config; send sample texts to the LLM |
| `version` | print the package version and, from a git checkout, the short commit |
| `install-service [--enable]`, `uninstall-service` | systemd user unit |

Options: `--headed`, `--live`, `--mode spam|full`, `--state-dir DIR`.

## Settings

`~/.config/messages-control/config.json` (written by `init`, owner-only)
overrides the defaults in `settings.js`:

| Key | Default | |
| --- | --- | --- |
| `endpoint` | OpenAI chat completions | any OpenAI-compatible URL (LiteLLM, OpenRouter, Ollama…) |
| `model` | `gpt-4o-mini` | needs JSON output; pictures need a vision model |
| `apiKey` | | or `MESSAGES_CONTROL_API_KEY` in the environment |
| `mode` | `spam` | `spam` or `full` |
| `dryRun` | `true` | `--live` sets it false for that run; holds blocks and trashing only, not `full` mode's archiving |
| `spamAction` | `block` | `block` (block & report) or `trash` |
| `threshold` | `0.8` | spam probability needed to act |
| `skipNamedContacts` | `true` | skip automatic classification when the displayed name has no digits or `@`; not an address-book lookup |
| `openPictureThreads` | `true` | open picture threads so the model sees them (marks them read) |
| `unsubscribeMarketing` | `false` | reply `unsubscribeText` (`STOP`) to a marketing sender before trashing its thread |
| `notifyCommand` | | shell command run on every action and failure, with `MC_EVENT` and `MC_MESSAGE` set |
| `prompt` | see `settings.js` | the classifier instructions |

## Policies

What happens to a thread is decided by rules in `policy.js`, tried in
order; the first whose `match` fits the verdict wins. The defaults are:

| Rule | Match | Action | Modes |
| --- | --- | --- | --- |
| `spam-block` | label spam, score ≥ `threshold` | `spamAction` (block & report, or trash) | spam, full |
| `marketing-delete` | label marketing | trash | spam, full |
| `otp-archive` | label otp, flagged by the model | archive after 6 h | full |
| `notice-archive` | label notice | archive after 24 h | full |

In full mode a fifth rule, `spam-review`, holds spam-ish threads under the
threshold (score ≥ 0.5) for a person: `messages-control review` lists them
and `messages-control act <id> block|trash|archive|keep [--live]` decides
one (`keep` is remembered, so no rule fires on it again).

`messages-control undo <event>` reverses a block (Spam & blocked →
Unblock / Not spam) or an archive (Archived → Unarchive) by its number in
`log`; the thread is then remembered as kept. A trashed thread cannot be
undone: Messages for web has no trash view.

`messages-control policy show` prints the rules in force;
`messages-control policy test` replays every cached verdict through them
and tallies what each rule would do, touching nothing. A `"policies"` list
in the config replaces the defaults, e.g. to keep political texts instead
of blocking them:

```json
"policies": [
  { "name": "spam-trash", "match": { "label": ["spam"], "minScore": 0.9 }, "action": "trash" },
  { "name": "marketing-keep", "match": { "label": ["marketing"] }, "action": "keep" }
]
```

Fields: `match.label` (list), `match.minScore` (number or `"threshold"`),
`match.byModel`, `action` (`block_report`, `trash`, `archive_after` with
`hours`, `keep`, or `spamAction`), `modes`, `enabled`. Threads skipped by the
name heuristic do not reach the automatic rules. Explicit manual actions
still operate on the thread you select.

## Notifications and the daily digest

```json
"notify": {
  "telegram": { "token": "123:abc", "chatId": "42" },
  "command": "mail -s \"$MC_EVENT\" me@example.com <<< \"$MC_MESSAGE\"",
  "events": ["pairing-approval", "unpaired", "llm-failing", "digest"]
}
```

Telegram gets plain text (the pairing emoji as a photo); `command` runs
with `MC_EVENT`, `MC_MESSAGE` and `MC_PHOTO` set. Events: `action` (every
block, delete or archive), `pairing-approval`, `unpaired`, `llm-failing`,
`crash`, `browser-closed`, `digest`; `events` omitted means all of them.

`messages-control digest [--since 7d] [--send]` summarises the events
table: counts, each action with the model's reason, what dry run held,
errors. `install-service --digest 08:00` adds a systemd timer that sends it
daily.

## API, dashboard and monitoring

While `run` is active it serves `http://127.0.0.1:7373/` (`api.bind`,
`api.port` in the config; port 0 turns it off). To put the dashboard behind
a reverse proxy, bind beyond loopback and list the names requests will
carry — `"api": { "bind": "0.0.0.0", "hosts": ["messages.lan.example"] }` —
other `Host` headers are refused; `/api/*` keeps its token.

- `/healthz` — 200 when paired and the page answers, 503 otherwise. No token.
- `/metrics` — Prometheus text, no token: `messages_control_healthy`,
  `messages_control_paired`, `messages_control_dry_run`,
  `messages_control_last_scan_timestamp_seconds`,
  `messages_control_events_total{outcome=…}`,
  `messages_control_verdicts{label=…}`, `messages_control_llm_calls_total`,
  `messages_control_llm_failures_total`, `messages_control_llm_seconds_total`,
  `process_start_time_seconds`.
- `/` — the dashboard: health, the last 24 hours, the review queue with
  keep/archive/block/trash buttons, recent activity with "View message", the
  rules in force, a "Scan now" button. View message shows the sender, action,
  reason and saved preview before offering "Undo block" or "Unarchive".
  Previews contain up to 500 characters from the conversation list, not the
  full conversation or attachments. Viewing them does not open the Google
  Messages conversation or change its read status. If an older event has no
  saved preview, review and undo it in Google Messages instead. Undo results
  and failures now retain the original action's preview. Older undo records
  can show a dated earlier block/archive preview from the same conversation
  as context; it is labeled because those records did not identify the exact
  action reversed. The current verdict is never substituted for history.
- `/api/status`, `/api/events?since&limit`, `/api/events/:id`, `/api/review`, `/api/policies`,
  `/api/verdicts`; `POST /api/act {id, action}`, `POST /api/undo {event}`,
  `POST /api/scan {includeSeen, checkPictures, trashSpam, processAll}` —
  all behind `Authorization: Bearer <api.token>`. The token is generated on
  the first run and written to the config; the dashboard asks for it once.

Prometheus scrape config:

```yaml
- job_name: messages-control
  static_configs:
    - targets: ['127.0.0.1:7373']
```

Alert on `messages_control_healthy == 0` (or the target going down) and on
`increase(messages_control_llm_failures_total[1h]) > 5`.

## Desktop app

`desktop/` is an Electron shell for people who don't want a terminal: it
runs the watcher, shows the dashboard in a window, offers "Pair with
phone…" from the tray (opens the sign-in window) and restarts the watcher
on failure, like the systemd unit.

```sh
cd desktop && npm install && npm start          # development
npm run dist                                    # desktop/dist/ (electron-builder)
```

`npm run dist` produces `desktop/dist/linux-unpacked/` (about 285 MB: Electron
plus the CLI, its dependencies and the dashboard under `resources/app/`);
add a target such as `--linux AppImage` or `--win` for an installer.

It expects Node and the repo's `node_modules` (`npm install` at the top
level, `npx playwright install chromium`) beside it; `MESSAGES_CONTROL_NODE`
points it at a specific node binary.

The desktop build narrowly overrides `global-agent` for `@electron/get` 3.x
to 4.1.3, removing the obsolete `roarr`/`sprintf-js` dependency chain. Its proxy
bootstrap is exercised against a local fixture in the required CI test job.
Remove the override when the upstream downloader dependency no longer needs it.

## Running as a service

```sh
messages-control install-service --live --digest 08:00 --enable
journalctl --user -fu messages-control
loginctl enable-linger        # keep it running while logged out
                              # (WSL: sudo loginctl enable-linger $USER)
```

If the phone unpairs the computer, the watcher notices on its next page
reload (`reloadMinutes`, 20), signs in again with the browser's Google
session, and asks the phone to confirm: the log and `notifyCommand`
(`MC_EVENT=pairing-approval`) get the three-digit code in words ("Your
verification code is 5 9 0…") and the matching emoji is saved as
`pairing-emoji.png` in the state dir. The watcher keeps asking (a fresh
code each round, notifications spaced out to an hour) until you tap that
code in Google Messages on the phone (profile picture → Device pairing if
no prompt appears). No window needed. Only when the Google session itself
is gone does it exit `2` (run `pair --headed`); `3` means the LLM endpoint
kept failing (restarts after 30 s). `notifyCommand` fires on all of these,
e.g. `telegram-send "$MC_MESSAGE"`.

## Storage

`~/.local/state/messages-control/`: `profile/` (the browser, with the
pairing), `state.json` (what the page keeps: seen threads, verdict cache,
the recent log) and `state.db` (SQLite: an append-only `events` table with
every log entry and the rule that produced it, and a `verdicts` table
mirrored from the cache). `log` and `status` read `state.db`; `clear-log`
clears only the page's recent log.

## Privacy

Classification sends message text, sender names and enabled pictures to the
LLM endpoint you configure. The name heuristic described above is not a
guarantee that saved contacts are excluded. Your provider's retention and
privacy terms apply to that data.

Google Messages communicates with Google and your paired phone. Opening a
conversation can mark it read and send RCS receipts. Block & report sends the
sender's number and recent messages to Google; configured STOP replies send
an outgoing message to the sender. Optional Telegram or command notifications
and digest delivery can send sender information, classification reasons,
message summaries and pairing approval information to their configured
destinations.

Configuration, the browser profile, `state.json` and `state.db` contain
sensitive credentials or message data. Configuration and state files are
written with owner-only permissions; protect the state directory, Docker
volume and backups too. Activity previews retain up to 500 characters.
Do not include real messages, API keys, tokens or browser profiles in issues
or screenshots. See [SECURITY.md](SECURITY.md) for private reporting guidance.

## Development

`npm test` (`node --test`, no install needed) runs the unit tests: the
policy rules, classifier parsing and failure handling, the store, the event
log, notifications, the digest and the local API. `npm run test:integration`
(after `npm ci` and `npx playwright install chromium`) runs the real CLI, a
headless Chromium and the page driver against a mock Messages page
(`test/integration/mock/`: the same elements and attributes the driver
relies on, a keyword classifier, and a record of every action the page
took), end to end: scan, block, STOP + trash, undo, keep, status. CI runs
both in the required `test` check. The real page remains the test bed for
selector changes and the `content.js` flow in Google's own DOM:
`messages-control diagnose` and `--headed`; run the mock by hand with
`node test/integration/mock/server.mjs 7474` and
`MESSAGES_CONTROL_MESSAGES_URL=http://127.0.0.1:7474/web/`.

Desktop dependency verification uses `npm ci --prefix desktop` followed by
`npm run test:desktop`: the downloader's actual proxy bootstrap and HTTP
download run against a local proxy fixture. The required CI job installs
desktop dependencies without lifecycle scripts for this check. Dependency
audits are `npm audit` and `npm audit --prefix desktop`.

The required `gitleaks` check runs `tools/scan-secrets.sh` with a pinned,
checksum-verified Gitleaks binary and scans full available Git history for
every event. It does not require a license secret or skip fork PRs.
Run it locally with Gitleaks 8.18.2 on PATH or `GITLEAKS_BIN=/path/to/gitleaks`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor setup.

- `messages-dom.js`: Google Messages DOM driver (list, read, delete, block,
  archive, diagnose). No `chrome.*` APIs.
- `content.js`: new-thread detection and the classify → act flow. Uses
  `chrome.runtime.sendMessage` and `chrome.storage.local`.
- `policy.js`: the rules (above); plain script shared by the page and Node.
- `src/page-shim.js`: the slice of `chrome.*` those two use, backed by Node;
  `src/cli.js` injects shim + driver + content.js into the page.
- `src/backend.js`: the LLM call and the log. `src/store.js`:
  `chrome.storage.local` on a JSON file. `src/pair.js`: pairing.
  `src/browser.js`: the persistent Chromium profile. `src/config.js`: modes
  and the config file.
- `src/db.js`: the SQLite events and verdicts tables. `src/notify.js`:
  Telegram and command notifications. `src/digest.js`: the digest text.
  `src/api.js` and `src/dashboard.html`: the local API, `/healthz`,
  `/metrics` and the dashboard.
- `background.js`, `panel.*`, `options.*`, `settings.js`: the same code as a
  Chrome extension (load unpacked in a Chrome that is already paired).
  `settings.js` holds the defaults for both.

Selectors in `messages-dom.js` are guesses with fallbacks; when Google
changes the UI, `diagnose` shows what still matches.

## Repository and harness maintenance

Start at the [agent guide](AGENTS.md) and
[messages-control-dev skill](.agents/skills/messages-control-dev/SKILL.md) for source ownership,
verification and delivery. The skill keeps this repository's operational
boundaries local and routes general harness upkeep to the shared workflow.
