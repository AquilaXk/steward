# Architecture

Steward has a functional core and explicit I/O boundaries.

```text
Host input, MCP request, or generic event
        |
        v
Adapter: shape checks, event names, tool aliases, file paths
        |
        v
Approved bundle: strict policy + exact verification commands
        |
        v
Pure engine: match -> deny decision -> context allocation
        |
        +--> disk snapshot on compaction
        +--> saved checkpoint envelope on session start
        |
        v
Protocol encoder -> prepared receipt -> stdout / stdio JSON-RPC
```

`src/engine.mjs` does not read files, execute commands or contact providers. Predicates
within one array combine with OR; different predicate fields combine with AND. Rules
are ordered by descending priority and then ID. Required injected rules receive budget
first; a missing required rule denies the event. Deny rules never compete for that budget.
The limit is UTF-8 bytes, not a claimed model token count.

`src/matcher.mjs` evaluates CLI argument globs (`patternsAny`, `globsAny`) using a
linear-time algorithm with 128-bit ASCII bitmaps and an explicit step ceiling that fails
closed (`GLOB_COMPLEXITY`) rather than backtracking indefinitely.

`src/trust.mjs` validates both catalog and command plan before computing a canonical
SHA-256 digest. Trust is stored under a project-specific key outside the project.
There is no implicit user/project override merge and no error-to-allow setting.
Canonical equivalence permits harmless JSON formatting changes. An operator can inspect
and approve a new bundle explicitly, and optionally sign or verify it with Ed25519 keys
(`src/crypto.mjs`).

`src/service.mjs` composes the adapter, trust, engine, persistence and audit. Receipts
are written before stdout is emitted. The stage is therefore `prepared`; a failed pipe
still does not become a false statement that the host consumed the text.

`src/journal.mjs` uses one file per record, a sequence number, a previous hash and a
content hash. A directory lock serializes cooperating writers. An incomplete temporary
file is ignored; completed malformed records block further writes. No stale lock is
automatically broken. An external anchor supports suffix-loss detection.
`src/index-cache.mjs` maintains an in-memory secondary index over validated journal
entries and returns deeply frozen records so callers cannot mutate cached state.

`src/verify.mjs` runs reviewed argv arrays using `spawnSync` with `shell:false`.
A check timeout kills the direct child. This is deliberately not represented as a
cross-platform process sandbox or a guaranteed cleanup of grandchildren. The runner
records bounded stdout and stderr separately and hashes their bytes. Its environment
contains a limited operating-system allowlist, not inherited provider credentials.

The source snapshot excludes `.git`, `node_modules` (at any directory depth), local
state, install receipts, and reviewed `plan.exclude` path prefixes. Other files,
including lockfiles and the selected policy, are hashed. Symbolic links in ordinary
source are fingerprinted as links, not followed. Control-plane paths reject symlinks
and project escape. The completion gate verifies the full cryptographic journal chain
freshly from disk (`fresh: true`) and checks plan identity, runtime, freshness and
stored output hashes.

## Deliberate scope

`src/adapters/mcp.mjs` provides a local, zero-dependency stdio JSON-RPC 2.0 MCP server
exposing Steward's eight tools and five resources with a 1 MiB message ceiling and
trusted-bundle enforcement. There is no remote network listener, provider SDK, web UI,
semantic vector index, unattended background scheduler, automatic deployment or global
skill registry. Local hooks, the local stdio MCP adapter, and the generic JSON interface
are enough for this project. A separate orchestrator can call these interfaces, but must
honor deny responses itself and enforce real OS and network permissions.
