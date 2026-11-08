# Contributing

Thank you for contributing.

## Before opening a pull request

1. Use synthetic data only.
2. Run `npm test`.
3. Run `npm run privacy:check`.
4. Do not commit storage directories, logs, backups, model files, session mappings or machine-specific paths.
5. Add a regression test for behavioral changes.

## Design expectations

- Memory writes must be recoverable and concurrency-safe.
- Recall must require direct relevance evidence; recency alone is not relevance.
- Consolidation callers must not acknowledge data before their durable memory writes succeed; the plugin validates tokens but cannot infer external write intent.
- Cross-session routing must never silently mix stores.
- New debug routes must be disabled by default if they expose memory content.

## Test fixtures

Use temporary directories and generated identifiers. Tests must never read a developer's real DSH home or memory database.
