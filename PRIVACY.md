# Privacy

`dsh-memory-v2` is local-first, but local-first does not mean encrypted.

## What is stored

Depending on how the plugin is used, the DSH data directory may contain:

- raw user and assistant messages;
- extracted memories, preferences, states and conclusions;
- source references and scene identifiers;
- human-readable mirrors and compressed snapshots;
- candidate audit records and operational metadata.

These files are stored as plain text, JSON, Markdown or gzip-compressed JSON. The plugin does not provide encryption at rest.

## Network behavior

- The core store, keyword recall, trace and consolidation logic are local.
- Semantic recall is disabled by default.
- When semantic recall is enabled, the implementation only loads a locally installed model and disables remote model downloads.
- This repository does not include telemetry or analytics code.

## Sensitive endpoints and logs

- Diagnostic logging is disabled by default and excludes message bodies, session IDs and RPC identifiers.
- `/memory-v2/candidates` is disabled by default because it can return candidate memory text.
- `/memory-v2/stats` returns counts only.

## Operator responsibilities

- Protect the DSH data directory with appropriate operating-system permissions.
- Do not commit real storage directories, logs, backups, configuration files or session mappings.
- Review backups before sharing them.
- Use synthetic fixtures in bug reports and tests.
- If the machine is shared, consider full-disk encryption or an encrypted user profile.

## Repository privacy boundary

The published source package contains no production memory store, conversation archive, session mapping, account identifier or machine-specific absolute path. Run `npm run privacy:check` in the source repository and `npm run privacy:check:artifact` against a clean release tree before publishing. Artifact mode rejects `.git`, `node_modules`, storage, backup and staging directories; installed mode is reserved for prepack checks after dependencies exist.
