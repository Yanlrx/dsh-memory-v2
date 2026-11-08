# Security Policy

## Supported versions

Security and privacy fixes are provided for the latest release on the default branch.

## Reporting a vulnerability

Please use the repository host's private security-advisory feature. Do not include real conversations, memory databases, session IDs, account identifiers or local file paths in a public issue.

Provide a minimal reproduction using synthetic data and include:

- affected version;
- operating system and Node.js version;
- expected and observed behavior;
- a redacted stack trace, if available;
- security or privacy impact.

## Security boundaries

- The plugin assumes the local DSH data directory is trusted and access-controlled.
- Stored memories are not encrypted at rest.
- The optional candidate endpoint exposes memory text and is disabled by default.
- Session-to-store routing is configuration-driven; operators are responsible for protecting and validating their mapping file.
