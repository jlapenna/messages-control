# Security

Use GitHub's **Security → Report a vulnerability** private reporting option
when available. If it is unavailable, open an issue requesting a private
reporting channel without including vulnerability details. Do not post API
keys, dashboard tokens, real messages, pairing information or browser profiles.

Include the commit/version, affected surface (CLI, extension, desktop or
dashboard) and a reproduction using synthetic data. The current main branch
is maintained; there is no promise of fixes for older versions.

The dashboard binds to loopback by default. Keep its token private and use
TLS and authentication when exposing it through a reverse proxy. Health and
metrics endpoints do not require a token. LLM providers and optional
notification destinations receive the data described in README's Privacy
section. Classification is probabilistic; review dry-run results before
enabling destructive actions.
