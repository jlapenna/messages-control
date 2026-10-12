---
name: messages-control-dev
description: Develop Messages Control's standalone runner and Chrome extension, its DOM selectors, classification policy and repository documentation. Use for any source, test, documentation or delivery work in this repository, including deciding which checks prove a change.
---

# messages-control-dev

Read [README.md](../../../README.md) for behavior and source ownership. Use a
dedicated feature worktree from current `origin/main`. `npm test`,
documentation and syntax checks need no dependency installation; run `npm ci`
(which brings Playwright) only when a workflow needs the browser or an explicit
request authorizes it.
Read the shared
[worktree-hygiene](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/worktree-hygiene/SKILL.md)
and [land-pr](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/land-pr/SKILL.md)
workflows before Git mutation and publication.

## Locate the contract

`messages-dom.js` owns DOM interaction. `content.js` owns thread detection and
the classify → act flow; `policy.js` owns the rules that flow applies and is
shared by the page, Node and the tests. `src/page-shim.js` adapts Chrome APIs
for the standalone runner; `src/cli.js` owns the commands and injection.
`src/backend.js` and `background.js` implement the two backends, and
`settings.js` owns shared defaults. The other `src/` modules (API, event
database, digest, notifications, config, pairing, browser) are listed with
their jobs in CONTRIBUTING "Source layout"; keep that list the single inventory.
Persistent account state belongs to the private browser profile, `state.json`
and `state.db`, never to source or fixtures.

## Verify and report accurately

Use `node --check` on changed JavaScript and parse changed JSON. `npm test`
runs `node --test` over `test/*.test.js` without installing anything: it proves
the policy rules, the classifier answer parsing and failure counting in
`src/backend.js`, the store, the SQLite event log, the notification channels,
the digest and the local API against a fake page. `npm run
test:integration` (needs `npm ci` and a Playwright Chromium) drives the real
CLI, a headless Chromium and `messages-dom.js` against the mock page in
`test/integration/mock/`: scan, block, STOP + trash, undo, keep and status,
as CONTRIBUTING "Tests" describes. CI
([ci.yml](../../../.github/workflows/ci.yml)) runs both in the required
`test` check after `node --check` on every script and a parse of
`manifest.json`. None of that reaches Google's current DOM, the `content.js`
flow in the real page, pairing or the extension as loaded in Chrome: say so
instead of letting a green run stand for live DOM or account proof. A
selector or adapter change needs an explicitly authorized account journey
(`messages-control diagnose`, `--headed`) or a matching update to the mock
page. Check standalone and extension paths separately before claiming
parity. Do not add tests that only repeat prose.

## Account authority

`run`, `scan`, `sweep`, `act`, `undo`, pairing, classifier calls
(`test-classifier` included), `digest --send` and authenticated diagnostics
involve an external account or provider. Do not invoke them for documentation
checks.
Dry run only prevents blocking and trashing: it can still archive notices and open picture
threads, marking them read and sending RCS receipts. Pairing, profile deletion,
service installation and live message actions require the corresponding request.
Keep keys, snippets, photos and profile credentials out of shared evidence.
Deliver source through reviewed PRs with current-head checks and true limits.

## Maintain the guidance

Use the [shared harness-maintenance workflow](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/harness-maintenance/SKILL.md), adapted from
[Ryan Lopopolo's field guide](https://github.com/lopopolo/harness-engineering/tree/226c8d35fb6ea3ed55467753dba6dea2b5fd5778), when improving agent context.
Trace a concrete failure to the owning contract above; corroborate agent
explanations against source and evidence. Put stable invariants in the existing
API or check, and procedural detail in its owning document or skill reference.
Keep the root guide a router. Dated observations preserve history rather than
live state or permission. Documentation validation proves structure and source
consistency; claim improved agent behavior only with comparable fresh use.
