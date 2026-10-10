# Messages Control

Keeps a Google Messages inbox clean. A headless Chromium, paired with your
phone through messages.google.com/web, watches for new threads; each one is
classified by an LLM you point it at (any OpenAI-compatible endpoint), and:

- **spam** (scams, phishing, fake delivery/toll notices, political blasts,
  loan/crypto/job offers, wrong-number openers) is **blocked & reported**
  (reversible from Messages → Spam & blocked), or trashed if you prefer;
- **marketing** (a real store's sale, coupon, loyalty text) is **deleted**,
  never reported as spam.

Threads from saved contacts are never touched. It starts in **dry run**:
everything is logged, nothing is acted on, until you pass `--live`.

Two modes. `spam` (the default) does only the above, on new threads. `full`
also labels your history and archives one-time codes after 6 hours and
automated notices (order ready, delivered, driver arriving) after a day.
The [control plane spec](https://claude.ai/code/artifact/ec83c12d-7c1d-4f2c-9ff9-e97a2546cdca)
describes where `full` is going.

## Install

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
docker run -it -v messages-control:/data -e MESSAGES_CONTROL_API_KEY messages-control init
docker run -d  -v messages-control:/data --restart unless-stopped messages-control run --live
```

(Pairing needs a window; do it on a desktop and copy the state volume, or
run `pair --headed` locally with the same `--state-dir`.)

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
| `dryRun` | `true` | `--live` sets it false for that run |
| `spamAction` | `block` | `block` (block & report) or `trash` |
| `threshold` | `0.8` | spam probability needed to act |
| `skipNamedContacts` | `true` | never touch threads whose name has no digits |
| `openPictureThreads` | `true` | open picture threads so the model sees them (marks them read) |
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
`hours`, `keep`, or `spamAction`), `modes`, `enabled`. Threads from saved
contacts never reach the rules.

## Running as a service

```sh
messages-control install-service --live --enable
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

Message text, sender names and (if enabled) pictures of threads that are
not from saved contacts are sent to the LLM endpoint *you* configure.
Nothing else leaves the machine. The browser profile and `state.json` are
owner-only; the log keeps the model's one-line reasons and the first 500
characters of each checked thread.

## Development

`npm test` runs unit tests for the classifier parsing and the store. CI
runs them plus syntax checks. The real page is the only test bed for the
DOM driver: `messages-control diagnose` and `--headed`.

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
