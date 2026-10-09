---
name: messages-control-dev
description: Develop Messages Control standalone and Chrome extension code, DOM selectors, classification policy, and repository documentation.
---

# messages-control-dev

Read [README.md](../../../README.md) for behavior and source ownership. Use a
dedicated feature worktree from current `origin/main`. Run `npm ci` only when
dependency installation is explicitly authorized or required by an applicable
workflow. Documentation and syntax-only checks do not require installation.
Read the shared
[worktree-hygiene](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/worktree-hygiene/SKILL.md)
and [land-pr](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/land-pr/SKILL.md)
workflows before Git mutation and publication.

## Locate the contract

`messages-dom.js` owns DOM interaction. `content.js` owns thread detection and
classification/action policy. `src/page-shim.js` adapts Chrome APIs for the
standalone runner; `src/cli.js` owns injection. `src/backend.js` and
`background.js` implement the two backends, and `settings.js` owns shared
defaults. Persistent account state belongs to the private browser profile and
`src/store.js`, never to source or fixtures.

## Verify and report accurately

Use `node --check` on changed JavaScript and parse changed JSON. The current
`npm test` is a placeholder that fails; it supplies no automated behavioral
coverage. State that gap instead of treating syntax checks as policy or DOM
proof. A selector or adapter change needs an explicitly authorized account
journey or a suitable synthetic fixture. Check standalone and extension paths
separately before claiming parity. Do not add tests that only repeat prose.

## Account authority

`run`, `sweep`, pairing, classifier calls and authenticated diagnostics involve
an external account or provider. Do not invoke them for documentation checks.
Dry run only prevents trashing: it can still archive notices and open picture
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
