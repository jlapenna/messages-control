# messages-control repository agent guide

Messages Control keeps a Google Messages inbox clean: a Node-driven headless
Chromium (or the same code loaded as a Chrome extension) watches
messages.google.com, an OpenAI-compatible LLM classifies each new thread, and
the rules in `policy.js` decide what happens to it. The surfaces that break
users when they change are the Google Messages DOM selectors, the classifier's
JSON answer, the config keys, the CLI commands, and the local API routes and
metric names described in [README.md](README.md).

Read [README.md](README.md) and the
[messages-control-dev skill](.agents/skills/messages-control-dev/SKILL.md) before source changes.
The skill maps code ownership, local checks, outcome evidence and operational
authority. Follow it in a dedicated feature worktree from current `origin/main`.
Use the shared
[worktree-hygiene](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/worktree-hygiene/SKILL.md)
and [land-pr](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/land-pr/SKILL.md)
workflows for Git safety and publication.

## Routes

| Task | Start at | Proof |
| --- | --- | --- |
| Rules, backend, CLI, API, store, notifications | the skill's "Locate the contract" and the module list in README "Development" | `npm test` and `node --check`, as scoped in the skill's "Verify and report accurately" |
| DOM selectors and the page driver | the skill's "Account authority" | `npm run test:integration` against the mock page, updating the mock when the elements it copies change; Google's real DOM only through `messages-control diagnose` or a headed journey, and only when an account is explicitly authorized; the unit tests do not reach the page |
| Documentation and agent context | the skill's "Maintain the guidance" | every relative link resolves; skill frontmatter stays valid |
| Container image | [image.yml](.github/workflows/image.yml) publishes to GHCR on pushes to `main` and `v*` tags; there is no separate release runbook | the Image workflow run for that commit |

Keep this file a router. The skill's "Maintain the guidance" section says where
a durable lesson belongs; put it there rather than here.

Source maintenance does not authorize external account actions, hardware
operations, installation, credentials, releases or deployments. The owning
workflow and explicit request determine those actions. Check documentation and
skill structure without claiming unobserved runtime behavior.

<!-- fleet-onboard:begin -->

## Agent fleet membership

This repository is a member of the Agent LCARS fleet. The fleet's conventions
live in [jlapenna/agent-lcars](https://github.com/jlapenna/agent-lcars) and are
deliberately not restated here. Headless dispatches read the shared contract
from the file exported as `$AGENT_PROTOCOL_PATH`; interactive authors can
consult Agent LCARS's `docs/` for the dispatch, credential, and
published-workflow contracts. Do not copy the shared protocol into this repo.

Git safety and PR delivery follow the `worktree-hygiene` and `land-pr`
skills in the public [jlapenna/repo-tools](https://github.com/jlapenna/repo-tools) plugin. Do not
mirror their bodies locally; use the `repo-*` commands they describe. Keep
the primary checkout clean on `main`, author in a linked worktree, and run
this repository's own setup step in every new worktree before trusting its
hooks. Fleet `fleet-*` commands come from the fleet-tools package in
jlapenna/agent-lcars; hooks guard every invocation with `command -v`, so a
machine without the package degrades quietly.

Required checks on `main` are declared in `infra/github-ruleset/main.tf`
and applied by the Homelab executor, never by hand in the GitHub UI.

<!-- fleet-onboard:end -->
