# messages-control GitHub ruleset

This is the repository-owned declaration for its `Protect main` GitHub
ruleset. It intentionally has no credential, state-bucket value, or backend
prefix. The trusted Homelab executor (`bin/plan-fleet-github-ruleset.sh` in
jlapenna/homelab) supplies those at runtime and owns the scheduled drift
check. Do not run an unconfigured local apply.

Record the live ruleset id here once it is imported into this root's isolated
state. Repository CI initializes, formats, validates, and checks this root's
local contract; only the centralized executor receives backend and state
access.

## Live ruleset

Applied 2026-10-11 from jlapenna/homelab `bin/plan-fleet-github-ruleset.sh messages-control` (isolated state prefix `terraform/fleet-github-rulesets/jlapenna-messages-control`): ruleset id **24875597**, "Protect main", active; the follow-up plan was a zero diff.

## The review gate

A pull request merges only with one approving review of its current head;
GitHub dismisses an approval when the head moves. Agent LCARS reviews every
pull request as an ordinary reviewer, so its approval normally satisfies the
rule and its change request blocks the merge. Comment `/review` to ask for a
fresh review. Verified Renovate updates are approved without a review run.
