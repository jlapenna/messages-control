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

## Activating LCARS review

The rule requires `LCARS review` from the Agent LCARS App on the PR head. Do
not require `LCARS review (merge candidate)`: a ruleset evaluating the update
of `main` cannot see a check on the test merge commit, so every merge would
need the administrator bypass (jlapenna/agent-lcars#3473).

1. Merge the review publisher and run it from the default branch.
2. Verify a passing `LCARS review` check from app 4457090 on the head of each
   reviewed open PR.
3. Inspect the Homelab plan for the merged ruleset revision and apply it.
   Verify the effective rules on `main` and a clean follow-up plan.
4. Run the publisher again. It reads the effective branch rules on each run.
   Once the check is required, it publishes a failed check with the reason
   on heads awaiting review or carrying a blocking verdict.
5. After the next reviewed merge, confirm its rule suite records `pass`:
   `gh api "repos/jlapenna/messages-control/rulesets/rule-suites?ref=refs/heads/main"`.

For rollback, revert and apply the requirement before removing the publisher.
