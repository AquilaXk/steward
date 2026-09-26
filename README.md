# Steward

![Steward: carry the work, keep the evidence](assets/banner.svg)

**Local policy, durable memory and inspectable verification for coding agents.**

Node.js 22+ · MIT · Zero runtime dependencies · English / 한국어

[English](README.md) · [한국어](README.ko.md) · [CI](https://github.com/AquilaXk/steward/actions/workflows/ci.yml) · [Discussions](https://github.com/AquilaXk/steward/discussions)

Coding agents can complete long tasks, but the working agreement, remembered decisions
and evidence of completion often live in different places. Steward connects those
pieces through small local commands, a native Model Context Protocol (MCP) server,
programmatic TypeScript/Node.js APIs, and eight focused skills. Start with an isolated
demo, inspect the files, then adopt only the procedures your project needs.

> **What the evidence means.** Steward records policy decisions, saved notes and the
> outcome of reviewed local commands. A passing gate binds those checks to the source,
> executable permissions, plan and runtime. It does not certify a model, authenticate
> the writer, establish deployment status or replace the host's sandbox.

## Install

Use Node.js 22+ and a host with local file and command access.

**Claude Code**

```text
/plugin marketplace add AquilaXk/steward
/plugin install steward@steward
```

Start a new session, then run `/steward:steward-policy set up this project`.

**Codex CLI**

```sh
codex plugin marketplace add AquilaXk/steward
codex plugin add steward@steward
```

Start a new session and select `steward-policy` from the installed Steward plugin,
then ask it to set up the current project.

**Model Context Protocol (MCP)**

Generate ready-to-use client configuration for Claude Desktop, Cursor, or Antigravity:

```sh
node bin/steward.mjs mcp --config --host claude   # or cursor, antigravity
```

The agent configures the project's checks, shows the policy and executable commands
for approval, and installs the project hooks or client configuration. The plugin supplies
eight skills; project setup uses `--plugin` to avoid copying them again. The native host's own
hook trust and permissions still apply. Use [manual setup](#4-set-up-a-project)
if you are working from a clone.

## Contents

1. [Why Steward exists](#1-why-steward-exists)
2. [The workflow at a glance](#2-the-workflow-at-a-glance)
3. [Try the isolated demo](#3-try-the-isolated-demo)
4. [Set up a project](#4-set-up-a-project)
5. [Choose a skill](#5-choose-a-skill)
6. [Understand the evidence](#6-understand-the-evidence)
7. [Ecosystem, MCP and Developer Experience](#7-ecosystem-mcp-and-developer-experience)
8. [Repository map](#8-repository-map)
9. [Contribute and follow the project](#9-contribute-and-follow-the-project)
10. [References and attribution](#10-references-and-attribution)

## 1. Why Steward exists

A note that says “done” cannot tell you which commands passed or whether the source
changed afterward. A saved decision can lose its authority when separated from the
confirmation that produced it. A long instruction file can make a small task harder
than it needs to be.

Steward keeps three responsibilities visible:

| Responsibility | Local mechanism | What you can inspect |
|---|---|---|
| Policy | Validated rules, safe glob matchers, and exact bundle approval | Matching rule IDs, denials, injected context, and omitted guidance |
| Memory | Typed, hash-linked journal with in-memory index cache | Decisions, questions, knowledge, goals, checkpoints, schedules, and handoffs |
| Verification | Reviewed command arrays, output hashes, and a completion gate | Check status, output hashes, source identity, freshness, and Ed25519 signatures |

The default policy provides working guidance. It is not a universal command blacklist.
The initial verification plan deliberately fails until you configure real checks.

## 2. The workflow at a glance

```text
Review policy + checks ──► Approve the exact bundle ──► Install host hooks / MCP
                                     │
                          Work within the authorized task
                                     │
                         Record material decisions & state
                                     │
                       Run checks ──► Inspect evidence ──► Gate
```

Denials are applied before context budgets. Required guidance that cannot fit blocks
the event. Optional guidance that does not fit is reported as omitted.

Memory is explicit: append a decision, knowledge claim, schedule, or checkpoint when it
matters. Compaction saves already recorded state; it does not recover unrecorded conversation.
A named session restores only its own checkpoint digest.

## 3. Try the isolated demo

Clone the repository and use Node.js 22 or later. Contributors can select Node 22 with
the included `.nvmrc`. No npm package installation or provider API key is needed.

```sh
git clone https://github.com/AquilaXk/steward.git
cd steward
node --version
npm run check
npm run demo
node bin/steward.mjs --help
```

The demo creates a temporary project, runs three synthetic arithmetic tests, records
and restores a checkpoint, and rejects evidence after a source change. It removes its
fixture afterward and does not launch a native agent application.

For the full local software suite (183 tests covering engine, journal, index cache,
MCP server, Ed25519 crypto, pattern matcher, and CLI integration), run `npm run verify`
(or `npm test`). See the [verification record](evidence/VERIFICATION.md) for observed results
and their scope.

## 4. Set up a project

Keep this toolkit at a stable path. From its directory, replace
`/absolute/path/to/project` with the project you want to initialize.
For a marketplace installation, the agent uses the installed plugin root and adds
`--plugin` to both `init` and `install` below.

```sh
node bin/steward.mjs init --project /absolute/path/to/project
node bin/steward.mjs trust --project /absolute/path/to/project
```

Inspect `.steward/policy.json` and replace the failing placeholder in
`.steward/verify.json` with meaningful project checks. Run `trust` again to review the
updated rules, commands and digest. Approve that exact reviewed hash:

```sh
node bin/steward.mjs trust --project /absolute/path/to/project --approve REVIEWED_HASH
node bin/steward.mjs install --project /absolute/path/to/project --host codex
node bin/steward.mjs doctor --project /absolute/path/to/project --host codex
```

For Claude Code, use `--host claude` in the installation command. Complete the host's
own trust and permission review before relying on its hooks.

| Host / Interface | Skills / Capabilities | Hook or Client Configuration |
|---|---|---|
| Codex | `.agents/skills/steward-*` | `.codex/hooks.json` |
| Claude Code | `.claude/skills/steward-*` | `.claude/settings.local.json` |
| MCP Client | 8 Tools & 5 Resources | Stdio JSON-RPC via `mcp --config --host <host>` |
| Generic caller | Optional procedures | JSON via `hook --host generic` |

Claude installation also imports the shared `AGENTS.md` from `CLAUDE.md`.
Generated `.steward/USAGE.md` records the actual runner and example paths.
The skill paths in the table apply to manual setup; plugin setup uses the bundled
skills. After a toolkit or plugin update, run `update --host codex` (or `claude`)
from its current path. Before removing a plugin, run `uninstall --host <host>` to
remove its project hooks and unchanged managed skills while retaining project data.

**Customized files are preserved.** Update stops on modified managed skills; existing
unowned files remain in the `skipped` list. Earlier branded installations are not automatically
migrated. Read [operations](docs/OPERATIONS.md) and the
[host smoke test](docs/HOSTS.md#required-native-smoke-test) before adopting hooks.

Run `version` to inspect the installed version. Package, CLI and plugins share
`0.2.0`; [release notes](CHANGELOG.md) explain the versioning policy and changes.

**Operational and maintenance commands:**

- **Adding journal records:** Append a typed record (`decision`, `question`, `knowledge`, `goal`, `schedule`, `handoff`):
  ```sh
  node bin/steward.mjs journal add --project /absolute/path/to/project --file /path/to/entry.json
  ```
- **Listing the validated journal:** Read and display the complete, verified journal sequence:
  ```sh
  node bin/steward.mjs journal list --project /absolute/path/to/project
  ```
- **Querying memory:** Recall active journal records with type, text, limit, session, or record filters:
  ```sh
  node bin/steward.mjs journal query --project /absolute/path/to/project \
    --type decision --text <term> --limit 20
  ```
  Filter by `--type` (`decision`, `question`, `knowledge`, `goal`, `checkpoint`, `schedule`, `handoff`, `verification`), `--text`, `--limit` (1–100, default 20), `--record-id`, or `--session-id`. Expired knowledge and superseded records are excluded by default; pass `--history` to inspect past revisions.
- **External integrity anchor:** Prevent journal suffix deletion by recording an anchor outside the project:
  ```sh
  node bin/steward.mjs journal anchor --project /absolute/path/to/project > /safe/place/project-anchor.json
  node bin/steward.mjs journal verify --project /absolute/path/to/project --anchor-file /safe/place/project-anchor.json
  ```
- **Simulating policy evaluation:** Evaluate a draft event against project rules in simulation mode without activating hooks:
  ```sh
  node bin/steward.mjs eval --project /absolute/path/to/project --input /path/to/event.json
  ```
- **Inspecting policy and audit reports:** Count prepared context injections, rules omitted due to budget limits, and check audit headroom:
  ```sh
  node bin/steward.mjs report --project /absolute/path/to/project
  ```
- **Auditing agent instructions:** Check instruction files (`AGENTS.md`, `CLAUDE.md`, skill files) for common prompt-contract conflicts:
  ```sh
  node bin/steward.mjs instructions-audit --project /absolute/path/to/project
  ```
  Flags potential stalls (`approval-stall`), unbounded loops (`unbounded-tests`), suppressed errors (`suppressed-failure`), instruction hierarchy conflicts (`hierarchy-conflict`), and private reasoning exposure (`private-reasoning`).
- **Pruning audit receipts:** The audit log retains up to 20,000 output-preparation receipts. Prune older records when approaching the ceiling:
  ```sh
  node bin/steward.mjs audit prune --project /absolute/path/to/project --keep 5000
  ```

## 5. Choose a skill

Use one relevant procedure; the eight skills are not mandatory pipeline stages.

| Skill | Use it for | Result |
|---|---|---|
| `steward-work` | A sustained authorized task | Deliverable, progress and scoped completion |
| `steward-recall` | Prior context that affects a decision | Relevant facts with source and freshness |
| `steward-decisions` | A confirmed choice or superseding change | An attributed journal record |
| `steward-checkpoint` | Context loss or a handoff | A persisted next action with a session boundary |
| `steward-verify` | Meaningful completion evidence | Observed checks and an explicit evidence scope |
| `steward-delegate` | Independent work with real collaboration tools | Bounded assignments and integrated results |
| `steward-policy` | Explicit setup or policy diagnosis | Reviewed configuration and trust state |
| `steward-schedule` | An explicitly requested dated note | A passive record, without timers or reminders |

Invoke policy and schedule explicitly: `$steward-policy` / `$steward-schedule` in
Codex, or `/steward-policy` / `/steward-schedule` in Claude Code. Their invocation
controls do not grant permission for mutations.
Claude plugin skills use the `/steward:steward-policy` and
`/steward:steward-schedule` names; select the bundled skills in Codex's skill picker.
When interacting via the MCP interface, these capabilities map directly to the
corresponding `steward_*` tools and `steward://*` resources.

To inspect an installation or refine a rule, invoke `steward-policy` and describe
the symptom or correction. `doctor` reports local hooks as configured, missing or
broken, while native behavior remains unchecked. `report` shows current-policy
matches, emitted and budget-omitted rules, last emission times, never-emitted
injection rules and remaining audit capacity. These are prepared outputs, not proof
that the host received or followed a rule.

The [model and skill review](docs/MODEL-GUIDANCE.md) maps the procedures to current
official GPT and Claude guidance. Model names are reviewed references, not runtime
settings or compatibility certifications.

## 6. Understand the evidence

After configuring and approving real project checks:

```sh
node bin/steward.mjs verify --project /absolute/path/to/project
node bin/steward.mjs gate --project /absolute/path/to/project
# Or verify against a specific historical evidence run:
node bin/steward.mjs gate --project /absolute/path/to/project --evidence EVIDENCE_HASH
```

When `--evidence` is omitted, `gate` verifies against the latest verification run recorded in the journal. A failed, unavailable,
stale or modified run cannot satisfy the gate. Commands execute with local user
privileges; captured stdout and stderr remain plaintext.

In `.steward/verify.json`, optional `exclude` path prefixes (such as `["dist", "coverage"]`)
prevent build outputs and test caches from invalidating the source code snapshot.

For a checkpoint, replace the fixture contents with actual task data and use the
exact host session ID when it is available:

```sh
node bin/steward.mjs checkpoint --project /absolute/path/to/project \
  --file /absolute/path/to/checkpoint.json --session-id HOST_SESSION_ID
```

Only a digest of the ID is stored. Without `--session-id`, the record is unscoped and
is restored only for events without a session ID. Do not guess a session ID.

**Implemented:** strict input validation; exact bundle trust; deny-first evaluation;
bounded guidance; typed journal reads and writes; session-matched checkpoints;
source-bound checks; installation preflight and recovery after caught write failures.

**Not established by those checks:** live host enforcement, model judgment,
deployment status, complete shell or symlink mediation, descendant-process cleanup,
or authenticated journal authorship. Retain an external journal anchor to detect
suffix removal. See [security](SECURITY.md), [memory](docs/MEMORY.md) and
[verification](docs/VERIFICATION.md) for the precise boundaries.

## 7. Ecosystem, MCP and Developer Experience

### Model Context Protocol (MCP) Server

Steward provides a native, zero-dependency MCP server adapter running over stdio JSON-RPC 2.0.
It exposes Steward's eight core capabilities as standard MCP Tools and Resources:

```sh
node bin/steward.mjs mcp --project /absolute/path/to/project
```

Print ready-to-use client configuration for Claude Desktop, Cursor, or Antigravity:

```sh
node bin/steward.mjs mcp --config --host claude   # or cursor, antigravity
```

**Exposed MCP Tools:**

- `steward_policy_eval`: Evaluate prompt, tool, or session events against active policy rules.
- `steward_recall`: Query journal records with type, text, session, and freshness filters.
- `steward_record_decision`: Append an attributed decision with authority reference and quote.
- `steward_checkpoint`: Persist session summary, next concrete action, and blockers.
- `steward_verify`: Run approved verification checks and capture execution evidence.
- `steward_completion_gate`: Check if recorded evidence satisfies plan and source snapshot.
- `steward_record_knowledge`: Record verified domain assertions with basis and expiration timestamps.
- `steward_schedule_manage`: Create or supersede milestone schedules with identity preservation.

**Exposed MCP Resources:**

- `steward://policy`: Active policy rules and budget configuration.
- `steward://verification-plan`: Approved verification checks and timeout budgets.
- `steward://journal/head`: Current sequence count and latest head hash.
- `steward://checkpoint/latest`: Most recent session progress checkpoint.
- `steward://doctor`: Health check and local trust status report.

### In-Memory Index Cache & High-Performance Recall

Steward automatically maintains an in-memory metadata index cache (`src/index-cache.mjs`) tracking
records by `type`, `recordId`, `session`, `tag`, and `supersededHashes` alongside file modification times.
Repeated queries avoid scanning the filesystem while invalidating cleanly on new appends and preserving
strict cryptographic hash-chain integrity.

### Programmatic TypeScript & Node.js API

Import the pure core engine directly into your external TypeScript or Node.js codebase with full type safety:

```ts
import {
  // Policy Engine & Safe Matcher
  evaluate,
  matchArgGlob,
  matchGlob,
  // Journal & In-Memory Index Cache
  appendEntry,
  readJournal,
  queryJournal,
  queryJournalIndexed,
  // Verification & Completion Gate
  runVerification,
  completionGate,
  // Model Context Protocol (MCP) Server
  startMcpServer,
  formatMcpConfig,
  // Ed25519 Asymmetric Digital Signatures
  generateSigningKeyPair,
  signBundle,
  verifyBundleSignature,
  signVerificationEvidence,
  verifyVerificationEvidence
} from 'steward';
```

Bundled `index.d.ts` declarations provide autocomplete and compile-time type validation for all policy, event, memory, and verification structures.

### Safe CLI Argument Pattern Matching

Policy rules optionally support linear-time safe glob matching (`patternsAny`, `globsAny`) to enforce fine-grained CLI argument boundaries without ReDoS risk. It handles character classes (`[a-z]`), wildcards (`*`), and escape sequences safely without backtracking regular expressions:

```json
{
  "id": "deny-destructive-flags",
  "on": ["tool"],
  "effect": "deny",
  "priority": 900,
  "body": "Destructive CLI operations are restricted.",
  "required": false,
  "match": {
    "tools": ["shell"],
    "patternsAny": ["rm -r[fF]*", "*--force*"]
  }
}
```

### Ed25519 Asymmetric Digital Signatures

Sign policy bundles and verification evidence to defend against local device compromise:

```sh
node bin/steward.mjs keygen --out ./keys
node bin/steward.mjs sign-bundle --key ./keys/steward-ed25519.priv.pem
node bin/steward.mjs verify-bundle --verifier ./keys/steward-ed25519.pub.pem
node bin/steward.mjs sign-evidence --evidence EVIDENCE_HASH --key ./keys/steward-ed25519.priv.pem
node bin/steward.mjs verify-evidence --evidence EVIDENCE_HASH --verifier ./keys/steward-ed25519.pub.pem
```

## 8. Repository map

```text
steward/
├── .codex-plugin/       # Codex plugin manifest
├── .claude-plugin/      # Claude plugin and marketplace
├── .agents/plugins/     # Codex marketplace
├── bin/                 # CLI entrypoint (steward.mjs)
├── index.d.ts           # TypeScript type definitions for library consumers
├── src/                 # Engine, trust, journal, verify, crypto, mcp and adapters
│   ├── adapters/        # Host and MCP protocol adapters
│   ├── crypto.mjs       # Ed25519 asymmetric signature engine
│   ├── index-cache.mjs  # In-memory journal metadata index cache
│   ├── matcher.mjs      # Linear-time safe glob pattern matcher
│   └── ...
├── schemas/             # JSON schemas for policies, verification, and journal entries
├── profiles/            # Default policy, initial checks and working agreement
├── procedures/          # Eight canonical skill sources
├── examples/            # Synthetic JSON inputs
├── test/                # Unit, filesystem-boundary, index cache, crypto, and CLI tests
├── scripts/             # Static checks, test runner, release prep, and isolated demo
├── docs/                # Contracts, architecture, agent context, host setup and model guidance
├── evals/               # Supervised behavioral cases; no fabricated live scores
├── evidence/            # Recorded local results and integrity manifests
└── assets/              # Original project artwork
```

| Start with | Then inspect |
|---|---|
| The isolated demo | [Policy contract](docs/POLICIES.md) and [Architecture](docs/ARCHITECTURE.md) |
| Project initialization | [Host setup](docs/HOSTS.md) and [Operations](docs/OPERATIONS.md) |
| Working context | [Agent context](docs/AGENT-CONTEXT.md) and [Security boundaries](SECURITY.md) |
| Saved decisions and checkpoints | [Memory contract](docs/MEMORY.md) |
| Completion claims | [Verification contract](docs/VERIFICATION.md) |
| Skill adoption | [Skill scopes](docs/SKILLS.md) and [Model guidance](docs/MODEL-GUIDANCE.md) |

## 9. Contribute and follow the project

Use [issues](https://github.com/AquilaXk/steward/issues) for reproducible bugs and
focused proposals, and [discussions](https://github.com/AquilaXk/steward/discussions)
for setup questions and workflow experience. Report vulnerabilities
[privately](https://github.com/AquilaXk/steward/security/advisories/new).

Read [CONTRIBUTING.md](CONTRIBUTING.md). Keep a failing regression case for a real
bug, preserve explicit failures, and distinguish local protocol tests from actual
host observations. Keep both README languages aligned.

CI exercises Linux, macOS and Windows on Node 22 and 24 with read-only workflow
permissions and commit-pinned actions. The npm package remains `private: true`;
publishing the source repository does not publish an npm package.

## 10. References and attribution

- [OpenAI GPT model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  and [Codex skills](https://developers.openai.com/codex/skills/).
- [Claude models](https://platform.claude.com/docs/en/models/overview),
  [Claude Fable 5.1 guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)
  and [Claude Code skills](https://code.claude.com/docs/en/skills).

Source review dates and scope are recorded in [docs/sources.json](docs/sources.json).
Steward is independent of OpenAI and Anthropic. Original project material is available
under the [MIT license](LICENSE); linked sources retain their own ownership.
