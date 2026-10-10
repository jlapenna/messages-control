# messages-control repository agent guide

Read [README.md](README.md) and the
[messages-control-dev skill](.agents/skills/messages-control-dev/SKILL.md) before source changes.
The skill maps code ownership, local checks, outcome evidence and operational
authority. Follow it in a dedicated feature worktree from current `origin/main`.
Use the shared
[worktree-hygiene](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/worktree-hygiene/SKILL.md)
and [land-pr](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/land-pr/SKILL.md)
workflows for Git safety and publication.

Keep this file a router. Repair the smallest authoritative source, document or
skill when guidance is missing; retain current contracts separately from dated
evidence. Load only the workflow relevant to the requested task.

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
