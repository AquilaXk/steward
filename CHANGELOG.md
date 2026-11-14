# Changelog

Package, CLI and plugin manifests share a semantic version. Git tags identify
released source as `vMAJOR.MINOR.PATCH`. Before 1.0, incompatible public CLI or
configuration changes increment the minor version; compatible fixes increment
the patch version. Journal and policy schema versions are independent: a package
release never silently rewrites stored records.

## 0.2.2

- Harden path, adapter, shell, CLI, MCP, and crypto boundaries fail-closed:
  walk intermediate symlink segments before resolving `..` in
  `resolveAdapterRelativePath` and reject null bytes in `relativePath`;
  close quote, brace-expansion, line-continuation, and command-substitution
  bypasses while bounding `DEFAULT_MAX_STEPS` and brace expansion in
  `src/matcher.mjs`; reject oversized raw NDJSON frames (`-32600`) before UTF-8
  decoding with stream backpressure in `startMcpServer`; pre-scan CLI options
  with string-flag skipping for `hook` denials and inline PEM checks; warn on
  pre-existing journals during `trust`, inspect `call_mcp_tool` payloads, parse
  top-level JSON transcript types safely, isolate checkpoint injections, and
  enforce Ed25519 key type and passing-evidence invariants.
- Accelerate hot paths and queries with `Uint8Array`/`Int8Array` ASCII/hex
  lookup tables, Unicode Simple Case Folding lookup tables, 128-bit required
  character precheck masks, `WeakMap` compiled policy caching over deep-frozen
  trusted bundles, async subprocess verification with in-lock batch completion
  gates, flat `Float64Array` stat columns and directory fast paths, lazy
  lowercased search text, `popcount32` word counting, monotonic time early exit,
  and bounded `receiptSummaryCache` summaries in `report()`/`pruneAudit()`.
- Export `prepareGlobTargets` publicly in `src/index.mjs` and `index.d.ts`,
  exclude non-command fields from `shell` tool text matching, cap workspace
  snapshot traversal at depth 64, support Windows `*-cli.js` discovery in
  `resolveSpawnSpec`, and verify behavior across 245 automated tests.

## 0.2.1

- Migrate project license to Apache-2.0 and document adapted open-source
  attributions in `THIRD_PARTY_NOTICES.md`.
- Optimize hot paths with packed 32-bit glob opcodes, raw-range `[Z-a]` bitmaps,
  extended shell operators/quotes/bounded brace expansion, zero-allocation
  schema validation helpers, `Uint32Array` bitset journal intersection with
  `Math.clz32` reverse traversal, write-through journal appends, and cached
  audit receipt counting.
- Harden adapters and MCP framing with `write_file`/`edit_file`/`Path` alias
  coverage, dangling and nested symlink resolution against project root,
  bounded backward transcript chunk scanning, clause-scoped instruction
  negation matching, and streaming UTF-8 `StringDecoder` stdio parsing.

## 0.2.0

- Add native plugin onboarding (`--host claude|codex|antigravity|all`,
  `plugin.json`, `mcp_config.json`, `rules/AGENTS.md`, `.claude-plugin/`,
  `.codex-plugin/`) and a `doctor` command that separates local wiring from
  observed host behavior.
- Add a zero-dependency stdio Model Context Protocol (MCP) server exposing 11
  tools and 6 `steward://` resources with multi-workspace `project` routing, a
  1 MiB line cap, JSON-RPC 2.0 validation, and trusted-bundle enforcement.
- Add Ed25519 asymmetric key generation (`keygen`) and domain-separated signing
  and verification for policy bundles (`sign-bundle`, `verify-bundle`) and
  verification evidence (`sign-evidence`, `verify-evidence`).
- Add linear-time CLI argument glob matching (`patternsAny`, `globsAny`) with
  128-bit `Uint32Array(4)` ASCII bitmaps, 16-bit packed POSIX shell operator
  tokenization, precompiled event/glob target caching, and a fail-closed
  `GLOB_COMPLEXITY` step ceiling.
- Add an in-memory secondary index cache (`src/index-cache.mjs`) for journal
  queries (`--tag`, `--since`, `--until`, `--record-id`, `--session-id`) with
  O(1) `byHash` / `metaByHash` lookup, smallest-set-first intersection, reverse
  early-exit scan, and lazy deep-freeze on matched records.
- Add `audit prune --keep <N>`, `verification.json` `exclude` path prefixes,
  recursive `.git`/`node_modules` snapshot exclusion, and `index.d.ts` TypeScript
  declarations.
- Add bounded journal queries with explicit history, expiry and supersession.
- Add managed updates and removal that preserve customized skills and project data.
- Generate host skill metadata from shared procedures and reject packaging drift.
- Preserve schedule identity across immutable revisions and reject forked updates.
- Report unused policy rules and remaining audit capacity for the current bundle.
- Synchronize package, CLI, TypeScript definitions, JSON schemas, and plugin
  versions through the static package check.

This release also includes the previously unreleased public-source preparation:
English and Korean README alignment, artwork, vendor-neutral model guidance, repository
metadata and pinned CI actions. Rename package, CLI, skill, state and trust identities
to Steward without automatically migrating old installations. Validate journal
envelopes, isolate checkpoint restoration by session digest, preflight hook writes
with rollback, and resolve project aliases before trust and host comparisons.

## 0.1.1 — 2026-09-07

Removed unrelated project material, dedicated import tooling, project-specific profiles
and their tests. Documentation and verification artifacts were regenerated for this delivery.

Added native Claude skill installation and `@AGENTS.md` import, preserving existing user
content. Canonical skill folders now match their names. Policy and schedule have explicit
invocation controls; all eight procedures now have tighter triggers and result contracts.
Generated local usage instructions resolve executable and example paths.

Fixed native relative file/patch paths to use the event working directory. Corrected
Claude SessionStart error output so it no longer claims unsupported startup blocking.
The starter verification plan now fails until real checks are configured.

Renamed workflow metadata and model documentation to provider-neutral paths, reviewed
current official guidance for both providers, and expanded supervised evaluation cases
without claiming live runs. Added 17 focused regressions while removing 5 tests belonging
to the removed feature; the local suite now contains 124 passing tests.

## 0.1.0 — 2026-09-07

Initial local policy, journal, verification, host adapters and task-scoped skills.
