# Contributing

## Development setup

Use Node.js 24. Read [AGENTS.md](AGENTS.md) and the
[development skill](.agents/skills/messages-control-dev/SKILL.md) for repository
workflow and account authority. Create a feature worktree from current
`origin/main`, then run:

```sh
./tools/setup-worktree.sh
```

Setup installs dependencies and the worktree guard required by commit and
push hooks. Submit a PR describing the behavior, relevant validation and limits.
Use synthetic examples in issues, fixtures and screenshots. Report security
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Tests

```sh
npm test
npx playwright install chromium
npm run test:integration
npm ci --prefix desktop --ignore-scripts
npm run test:desktop
```

Unit tests cover policy rules, classifier parsing and failure handling,
storage, events, notifications, digests and the local API. Integration tests
run the real CLI and page driver in headless Chromium against a synthetic
Messages page: scan, block, STOP + trash, undo, keep and status, and, with the
`run` watcher, message events (query, stream, restart catch-up), reading a
conversation back with its channel, and sending to a thread or a phone
number from the API and the CLI. They also
exercise the rendered extension settings with a simulated permission prompt.
The desktop test exercises the downloader's proxy bootstrap and artifact
validation against a local HTTP fixture. All three suites run in CI's
required `test` check.

These fixtures do not prove compatibility with Google's current UI. Selector
changes need corresponding mock updates and, when explicitly authorized,
verification against a real account. Live scans can mark messages read or
archive them even in dry run; source work does not authorize account actions.

Check changed JavaScript with `node --check`, parse changed manifests as JSON,
and verify relative documentation links. To run the mock page manually:

```sh
node test/integration/mock/server.mjs 7474
```

Point the CLI at it with
`MESSAGES_CONTROL_MESSAGES_URL=http://127.0.0.1:7474/web/`.

## Desktop build

Install root dependencies and Chromium first, then:

```sh
npm ci --prefix desktop
npm run dist --prefix desktop
```

The default build produces `desktop/dist/linux-unpacked/`. Select other
installer targets through electron-builder. The packaged app still needs a
Node executable; `MESSAGES_CONTROL_NODE` selects it.

## Dependency and secret checks

```sh
npm audit
npm audit --prefix desktop
GITLEAKS_BIN=/path/to/gitleaks ./tools/scan-secrets.sh
```

The required `gitleaks` check uses pinned Gitleaks 8.18.2, verifies its download
checksum, and scans all available Git history. It does not require an Action
license secret. A local scanner on PATH can be used without `GITLEAKS_BIN`.

Two dependency overrides address upstream transitive advisories. The root
package uses undici 7.29.1 for Nx 23.3.0. The desktop package uses global-agent
4.1.3 for @electron/get 3.x, removing its roarr/sprintf-js dependency chain.
Remove each override when the upstream dependency resolves a safe version;
verify the desktop proxy fixture when changing its downloader dependencies.

## Source layout

- `messages-dom.js`: Google Messages DOM driver (list, read, send, delete,
  block, archive, diagnose). No `chrome.*` APIs.
- `content.js`: new-thread detection and the classify → act flow. Uses
  `chrome.runtime.sendMessage` and `chrome.storage.local`.
- `policy.js`: the classification rules; plain script shared by the page and Node.
- `message-events.js`: standalone only. Reports new messages in the list as
  events and answers the API's thread queries and sends.
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
