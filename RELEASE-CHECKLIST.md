# Release checklist — v0.3.1

- [x] Release tree was assembled from an explicit whitelist; no private working directory was copied wholesale.
- [x] All 29 automated regression test files passed with the DSH Electron/Node runtime.
- [x] `tools/privacy-check.mjs` passed in artifact mode on the final release tree.
- [x] No personal names, account identifiers, machine-specific paths, runtime RPC identifiers, backups, logs, staging data, or private migration artifacts are included.
- [x] No production memory storage or user message content is included.
- [x] Historical UUID-shaped session fixtures and personalized test phrases were replaced with explicit synthetic examples.
- [x] Diagnostic logging does not emit message bodies, session identifiers, RPC identifiers, or owner mappings.
- [x] Semantic recall, diagnostic logging, and the candidate-body debug route are disabled by default.
- [x] The sensitive `/memory-v2/candidates` route is opt-in and documented.
- [x] Package contents are constrained by the `files` whitelist in `package.json`.
- [x] CI covers Windows and Linux on Node.js 20 and 22, including privacy, tests, and `npm pack --dry-run`.
- [x] MIT license, privacy notes, security policy, contribution guide, example config, ignore rules, and CI workflow are included.
- [x] The public author name is intentionally set to `伊万莉瑞希` in package metadata, README, and LICENSE.
- [ ] Repository URL and maintainer contact can be added by the publisher before the first public release.
- [ ] The package has not been uploaded, pushed, or published by this preparation step.

Final GitHub privacy re-audit: 2026-11-08
