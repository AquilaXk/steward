# Working on Steward

This package runs locally on Node 22+ with no third-party runtime dependencies.
Use clear English in source, tests and documentation; keep README.ko.md aligned.
Keep the pure policy engine separate from filesystem, trust and host adapters.
Never silently replace a policy error with allow. Test observable behavior, including
failed trust, invalid input, context budgets, concurrent writes and stale evidence.
Do not call model APIs or publish this package as part of a local change.
Use `npm run check` and `npm test` for changes to core behavior. Documentation-only
changes need the relevant document/package check, not arbitrary extra tests.
