# Usage guide

[Getting started](../README.md) · [Contributing](../CONTRIBUTING.md)

## Commands

| Command | What it does |
| --- | --- |
| `run` | Watch and act on new threads (the default). |
| `pair --headed` | Pair the browser with your phone through a sign-in window. |
| `scan` | one scan now; `--include-seen` treats the top 20 threads as new |
| `sweep` | "Process all messages": label the whole list, archive old codes and notices (full mode), act on spam and marketing unless dry run |
| `act-on-spam` | block/trash threads already labelled spam (`--live`) |
| `check-pictures` | open every pending picture thread and classify it |
| `diagnose` | what the page driver can see (thread count, menu found) |
| `log [--limit N]`, `clear-log` | the activity log |
| `status` | config, pairing, last scan, actions in the last 24 h, service state |
| `init`, `test-classifier` | write the config; send sample texts to the LLM |
| `version` | print the package version and, from a git checkout, the short commit |
| `install-service [--enable]`, `uninstall-service` | Install or remove the systemd user service. |
| `review` | List threads held for manual review. |
| `act ID ACTION` | Apply block, trash, archive or keep to a selected thread. |
| `undo EVENT` | Reverse a block or archive by its event number. |
| `send ID TEXT --live` | Send a message to a selected thread. |
| `digest [--send]` | Display a digest, or send it to notification destinations. |
| `policy show`, `policy test` | Display rules or evaluate them against cached verdicts. |

Options: `--headed`, `--live`, `--mode spam|full`, `--state-dir DIR`.

## Settings

`~/.config/messages-control/config.json` (written by `init`, owner-only)
overrides the defaults in [`settings.js`](../settings.js):

Use `MESSAGES_CONTROL_CONFIG` to choose a different configuration file and
`MESSAGES_CONTROL_STATE` or `--state-dir DIR` to choose a state directory.
The default locations also respect `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.

| Key | Default | Purpose |
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

What happens to a thread is decided by rules in `[`policy.js`](../policy.js)`, tried in
order; the first whose `match` fits the verdict wins. The defaults are:

| Rule | Match | Action | Modes |
| --- | --- | --- | --- |
| `spam-block` | label spam, score ≥ `threshold` | `spamAction` (block & report, or trash) | spam, full |
| `spam-review` | label spam, score ≥ 0.5 and below `threshold` | hold for review | full |
| `marketing-delete` | label marketing | trash | spam, full |
| `otp-archive` | label otp, flagged by the model | archive after 6 h | full |
| `notice-archive` | label notice | archive after 24 h | full |
| `transactional-keep` | label transactional | keep | spam, full |

In full mode the `spam-review` rule holds spam-ish threads under the
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
in the config replaces the defaults. For example, this configuration trashes
only high-confidence spam and keeps marketing:

```json
{
"policies": [
  { "name": "spam-trash", "match": { "label": ["spam"], "minScore": 0.9 }, "action": "trash" },
  { "name": "marketing-keep", "match": { "label": ["marketing"] }, "action": "keep" }
]
}
```

Fields: `match.label` (list), `match.minScore` (number or `"threshold"`),
`match.byModel`, `action` (`block_report`, `trash`, `archive_after` with
`hours`, `keep`, or `spamAction`), `modes`, `enabled`. Threads skipped by the
name heuristic do not reach the automatic rules. Explicit manual actions
still operate on the thread you select.

## Notifications and the daily digest

Choose Telegram, a shell command, or both. Add a `notify` section to your config:

```json
{
  "notify": {
    "telegram": {
      "token": "YOUR_BOT_TOKEN",
      "chatId": "YOUR_CHAT_ID"
    },
    "command": "printf \"%s\\n\" \"$MC_MESSAGE\" | mail -s \"$MC_EVENT\" me@example.com",
    "events": [
      "pairing-approval",
      "unpaired",
      "llm-failing",
      "digest"
    ]
  }
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
  saved preview, review and undo it in Google Messages instead.
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

## Running as a service

```sh
messages-control install-service --enable
journalctl --user -fu messages-control
loginctl enable-linger        # optional: keep running while logged out
```

The service uses your configured mode and dry-run setting. Add `--live` when
installing it to enable automatic blocking and deletion. Add `--digest 08:00`
to install a daily digest timer; configure a notification destination first.

If pairing is lost, the watcher tries to restore it using the saved Google
session and requests approval on your phone. Check Google Messages → Device
pairing if no approval prompt appears. If the Google session has expired, stop
the service, run `messages-control pair --headed`, then restart the service.
Do not open the same browser profile from two processes at once.

Exit code `2` means pairing needs attention; `3` means the classifier kept
failing. The service restarts failures after 30 seconds, except exit code `2`.
Use `messages-control uninstall-service` to remove the service and digest timer.

## Storage

`~/.local/state/messages-control/`: `profile/` (the browser, with the
pairing), `state.json` (what the page keeps: seen threads, verdict cache,
the recent log) and `state.db` (SQLite: an append-only `events` table with
every log entry and the rule that produced it, and a `verdicts` table
mirrored from the cache). `log` and `status` read `state.db`; `clear-log`
clears only the page's recent log.

## Docker

Pair locally before starting a container; the pairing command needs a desktop
window. This example uses a dedicated local state directory and copies it into
a new Docker volume:

```sh
messages-control pair --headed --state-dir ./paired-state
docker build -t messages-control .
docker volume create messages-control
docker create --name messages-control -v messages-control:/data --restart unless-stopped messages-control run
docker cp ./paired-state/. messages-control:/data/
docker run --rm -it -v messages-control:/data messages-control init
docker start messages-control
docker logs -f messages-control
```

`init` writes `/data/config.json`; the same volume stores the paired profile
and message state. Leave dry run enabled until you have reviewed the log.
To enable live actions, recreate the container with `run --live`, retaining
the volume. If you use an environment API key, pass `-e MESSAGES_CONTROL_API_KEY`
to each container that needs it.

The dashboard binds to container loopback by default. Publishing a port also
requires `api.bind` to be `0.0.0.0` and the request hostname to be in `api.hosts`.
Use an authenticated reverse proxy for access beyond your machine; keep the
API token requirement. See [API, dashboard and monitoring](#api-dashboard-and-monitoring).
Keep the volume and local `paired-state` directory private.

## Desktop app

The Electron app starts the standalone watcher, displays its dashboard, and
provides a tray menu for pairing, starting, stopping and viewing logs.
Complete the CLI setup first. Stop any existing watcher or service before
starting the desktop app because they share the same browser profile.

```sh
npm ci --prefix desktop
npm start --prefix desktop
```

Node.js and Chromium must be installed as in the CLI quickstart. To choose a
Node executable, set `MESSAGES_CONTROL_NODE`. For packaging instructions, see
[Contributing](../CONTRIBUTING.md#desktop-build).
