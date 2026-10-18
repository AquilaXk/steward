# Steward local verification

This is the current verification record for package version 0.2.0.
Environment: macOS arm64, Node v24.19.0 (Node 22+ compatible), npm 11.6.2.

| Command | Exit | Observed result |
|---|---:|---|
| `npm run check` | 0 | Module syntax (41 modules), JSON (25 files), package identity, skill metadata (8 skills), `index.d.ts` and schema parity, and local Markdown links/anchors |
| `npm test` | 0 | 213 passed; 0 failed, cancelled, skipped or todo |
| `npm run demo` | 0 | Three synthetic arithmetic tests; policy denial; checkpoint recovery; source-change rejection |
| Skill Creator structural validator | 0 | All eight canonical skills have valid names, frontmatter and complete bodies |

Raw suite output is in `test-results.tap`. Check and demo output is retained in
the corresponding JSON files (`check-results.json`, `demo-results.json`). `delivery.json`
records the collection timestamp and test summary.

The local software suite covers:
- Pure policy engine (`src/engine.mjs`), linear-time ASCII/Unicode glob matcher (`src/matcher.mjs`) with fail-closed `GLOB_COMPLEXITY` step limits, and POSIX shell operator tokenization (`src/adapters.mjs`).
- Ed25519 asymmetric keypair generation, symlink/permission hardening, and domain-separated bundle and verification evidence signatures (`src/crypto.mjs`).
- Append-only journal (`src/journal.mjs`) and in-memory secondary index cache (`src/index-cache.mjs`) with deeply frozen returned records and fresh hash-chain verification at the completion gate (`src/verify.mjs`).
- Zero-dependency stdio JSON-RPC 2.0 Model Context Protocol (MCP) server (`src/adapters/mcp.mjs`) with 1 MiB message bounds, trusted-bundle enforcement, 11 tools, and 6 resources.
- TypeScript declaration (`index.d.ts`) and JSON Schema (`schemas/*.json`) parity with runtime exports and validators.

Not run in this local capture: live Codex or Claude sessions, external model APIs, or
supervised behavioral cases (`evals/agent-workflow.json`). The public repository's
GitHub Actions workflow exercises the 6-job CI matrix across Ubuntu, macOS, and Windows
on Node 22 and 24.

Manifests hash the current repository files: `source-manifest.json` excludes `evidence/`;
`manifest.json` excludes itself (`evidence/manifest.json`). Manifests are integrity
records, not signatures or independent author authentication.
