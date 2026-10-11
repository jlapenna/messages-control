# Contributing

Use Node.js 24. Start with [AGENTS.md](AGENTS.md) and the linked development
skill for source ownership, account authority and delivery conventions.
Create a feature worktree from current `origin/main` and run
`./tools/setup-worktree.sh` there. The setup installs the public repo-tools
worktree guard required by the commit and push hooks.

The root package narrowly overrides Nx 23.3.0's pinned `undici` dependency to
the patched 7.29.1 release. Remove this override when the tooling no longer
resolves the vulnerable version.

Run `npm test`, then `npx playwright install chromium` and
`npm run test:integration`. Integration tests use synthetic local messages,
never a real Google account. For desktop changes, run `npm ci --prefix desktop`,
`npm run test:desktop` and `npm run dist --prefix desktop`. Check changed
JavaScript with `node --check`, and validate changed manifests as JSON.

Submit a PR describing the user-visible behavior, relevant validation and
any limits. Use synthetic examples in issues, fixtures and screenshots.
Live scans can mark messages read or archive them even in dry run; source
testing does not authorize actions on another person's account.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
