# Steward Runtime Governance Rule (Antigravity Plugin)

Steward (`v0.2.0`) is installed as an active Antigravity plugin providing deterministic, fail-closed policy evaluation, SHA-256 hash-chained persistent journal memory, and source-bound completion verification (`Node.js 22+`, zero runtime dependencies).

## Steward Toolkit, CLI & MCP Server

- **Plugin Root**: `~/.gemini/config/plugins/steward`
- **CLI Entrypoint**: `node ~/.gemini/config/plugins/steward/bin/steward.mjs <command> [--project <dir>] [options]`
  - Supports `--file` or `--input` interchangeably for `eval`, `journal add`, and `checkpoint`.
  - Supports first-class `--host antigravity` (and `--host all`) lifecycle hooks (`eval`, `hook`, `install`, `update`, `uninstall`, `doctor`) managing `.agents/hooks.json` (`steward` named hook for `SessionStart`, `PreInvocation`, `PreToolUse`, and `Stop`).
  - When a target workspace already contains `.steward/USAGE.md`, prefer the exact command prefix recorded in `.steward/USAGE.md`.
  - When initializing or diagnosing a workspace without `.steward/USAGE.md`, use `node ~/.gemini/config/plugins/steward/bin/steward.mjs` with `--plugin`.
- **Bundled MCP Server (`mcp_config.json`)**:
  - Exposes all 11 Steward MCP tools (`steward_policy_eval`, `steward_recall`, `steward_record_decision`, `steward_record_knowledge`, `steward_record_question`, `steward_checkpoint`, `steward_record_handoff`, `steward_goal_manage`, `steward_schedule_manage`, `steward_verify`, `steward_completion_gate`, plus aliases `steward_status` and `steward_doctor`) and 6 `steward://` resources (`steward://policy`, `steward://verification-plan`, `steward://journal/head`, `steward://checkpoint/latest`, `steward://doctor`, `steward://trust/status`).
  - Every MCP tool accepts an optional `project` directory parameter (and `steward_checkpoint` accepts `sessionId` or `session`) and every `steward://` resource accepts `?project=<urlencoded-path>` (plus `?sessionId=<id>` on `steward://checkpoint/latest`) for multi-workspace sessions.

## Available Steward Skills (`steward-*`)

Invoke the matching skill via `view_file` whenever its trigger condition applies:

1. **`steward-work`**: Multi-step authorized tasks that require durable goal tracking or completion gate verification (`.steward/` enabled workspaces).
2. **`steward-recall`**: Retrieving prior architectural decisions, domain knowledge, or open questions from `.steward/state/journal/` (`journal query`).
3. **`steward-decisions`**: Recording an explicitly confirmed user/QA decision or superseding an existing decision in the hash-chained journal (`journal add`).
4. **`steward-checkpoint`**: Saving a compact recovery point or typed handoff before context compaction or session handoff (`checkpoint`).
5. **`steward-verify`**: Running trusted completion checks (`verify`), checking source-snapshot gates (`gate --evidence <hash>`), or signing/verifying Ed25519 evidence (`sign-evidence`, `verify-evidence`).
6. **`steward-delegate`**: Scoping bounded, non-overlapping parallel subagent briefs with explicit file boundaries and verification contracts.
7. **`steward-policy`**: Initializing Steward (`init --plugin`), reviewing/approving trust digests (`trust`), simulating policy drafts (`eval`), inspecting context budgets (`report`), or generating MCP configs (`mcp --config`).
8. **`steward-schedule`**: Recording dated task or release intentions in the passive journal (`journal add` with `type: "schedule"`).

## Core Invariants

- **Fail-Closed Execution**: Never bypass a policy denial, trust mismatch, or failed completion gate (`gate`), and never fabricate user/QA approval for `trust --approve <digest>`.
- **Zero Unsolicited Repo Pollution**: Do not run `steward init` in a repository unless explicitly requested by QA or when `.steward/` is already part of that project's workflow.
