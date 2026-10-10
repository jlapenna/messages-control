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
