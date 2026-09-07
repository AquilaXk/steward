# Steward

![Steward: carry the work, keep the evidence](assets/banner.svg)

**Local policy, durable memory and inspectable verification for coding agents.**

Node.js 22+ · MIT · Zero runtime dependencies · English / 한국어

[English](README.md) · [한국어](README.ko.md) · [CI](https://github.com/AquilaXk/steward/actions/workflows/ci.yml) · [Discussions](https://github.com/AquilaXk/steward/discussions)

Coding agents can complete long tasks, but the working agreement, remembered decisions
and evidence of completion often live in different places. Steward connects those
pieces through small local commands and eight focused skills. Start with an isolated
demo, inspect the files, then adopt only the procedures your project needs.

> **What the evidence means.** Steward records policy decisions, saved notes and the
> outcome of reviewed local commands. A passing gate binds those checks to the source,
> executable permissions, plan and runtime. It does not certify a model, authenticate
> the writer, establish deployment status or replace the host's sandbox.

## Contents

1. [Why Steward exists](#1-why-steward-exists)
2. [The workflow at a glance](#2-the-workflow-at-a-glance)
3. [Try the isolated demo](#3-try-the-isolated-demo)
4. [Set up a project](#4-set-up-a-project)
5. [Choose a skill](#5-choose-a-skill)
6. [Understand the evidence](#6-understand-the-evidence)
7. [Repository map](#7-repository-map)
8. [Contribute and follow the project](#8-contribute-and-follow-the-project)
9. [References and attribution](#9-references-and-attribution)

## 1. Why Steward exists

A note that says “done” cannot tell you which commands passed or whether the source
changed afterward. A saved decision can lose its authority when separated from the
confirmation that produced it. A long instruction file can make a small task harder
than it needs to be.

Steward keeps three responsibilities visible:

| Responsibility | Local mechanism | What you can inspect |
|---|---|---|
| Policy | Validated rules and exact bundle approval | Matching rule IDs, denials and omitted guidance |
| Memory | Typed, hash-linked journal | Decisions, questions, goals, handoffs and session checkpoints |
| Verification | Reviewed command arrays and a completion gate | Check status, output hashes, source identity and freshness |

The default policy provides working guidance. It is not a universal command blacklist.
The initial verification plan deliberately fails until you configure real checks.

## 2. The workflow at a glance

```text
Review policy + checks ──► Approve the exact bundle ──► Install host hooks
                                     │
                          Work within the authorized task
                                     │
                           Record material decisions
                                     │
                       Run checks ──► Inspect evidence ──► Gate
```

Denials are applied before context budgets. Required guidance that cannot fit blocks
the event. Optional guidance that does not fit is reported as omitted.

Memory is explicit: append a decision or checkpoint when it matters. Compaction saves
already recorded state; it does not recover unrecorded conversation. A named session
restores only its own checkpoint digest.

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

For the full local software suite, run `npm test`. See the
[verification record](evidence/VERIFICATION.md) for observed results and their scope.

## 4. Set up a project

Keep this toolkit at a stable path. From its directory, replace
`/absolute/path/to/project` with the project you want to initialize.

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
node bin/steward.mjs doctor --project /absolute/path/to/project
```

For Claude Code, use `--host claude` in the installation command. Complete the host's
own trust and permission review before relying on its hooks.

| Host | Skills | Hook configuration |
|---|---|---|
| Codex | `.agents/skills/steward-*` | `.codex/hooks.json` |
| Claude Code | `.claude/skills/steward-*` | `.claude/settings.local.json` |
| Generic caller | Optional procedures | JSON via `hook --host generic` |

Claude installation also imports the shared `AGENTS.md` from `CLAUDE.md`.
Generated `.steward/USAGE.md` records the actual runner and example paths.

**Existing files are preserved, not automatically upgraded.** Inspect the returned
`skipped` list when updating. Earlier branded installations are not automatically
migrated. Read [operations](docs/OPERATIONS.md) and the
[host smoke test](docs/HOSTS.md#required-native-smoke-test) before adopting hooks.

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

The [model and skill review](docs/MODEL-GUIDANCE.md) maps the procedures to current
official GPT and Claude guidance. Model names are reviewed references, not runtime
settings or compatibility certifications.

## 6. Understand the evidence

After configuring and approving real project checks:

```sh
node bin/steward.mjs verify --project /absolute/path/to/project
node bin/steward.mjs gate --project /absolute/path/to/project --evidence EVIDENCE_HASH
```

Use the `evidence` hash returned by the run you inspected. A failed, unavailable,
stale or modified run cannot satisfy the gate. Commands execute with local user
privileges; captured stdout and stderr remain plaintext.

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

## 7. Repository map

```text
steward/
├── bin/           # CLI entrypoint
├── src/           # Policy, trust, state, verification and host adapters
├── schemas/       # Editor schemas; runtime enforces further invariants
├── profiles/      # Default policy, initial checks and working agreement
├── skills/        # Eight canonical skill sources
├── examples/      # Synthetic JSON inputs
├── test/          # Unit, filesystem-boundary and CLI process tests
├── scripts/       # Static checks, test runner and isolated demo
├── docs/          # Contracts, host setup and model guidance
├── evals/         # Supervised behavioral cases; no fabricated live scores
├── evidence/      # Recorded local results and integrity manifests
└── assets/        # Original project artwork
```

| Start with | Then inspect |
|---|---|
| The isolated demo | [Policy contract](docs/POLICIES.md) |
| Project initialization | [Host setup](docs/HOSTS.md) and [operations](docs/OPERATIONS.md) |
| Saved decisions and checkpoints | [Memory contract](docs/MEMORY.md) |
| Completion claims | [Verification contract](docs/VERIFICATION.md) |
| Skill adoption | [Skill scopes](docs/SKILLS.md) and [model guidance](docs/MODEL-GUIDANCE.md) |

## 8. Contribute and follow the project

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

## 9. References and attribution

- [OpenAI GPT model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  and [Codex skills](https://developers.openai.com/codex/skills/).
- [Claude models](https://platform.claude.com/docs/en/models/overview),
  [Claude Fable 5.1 guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)
  and [Claude Code skills](https://code.claude.com/docs/en/skills).
- The README's guided introduction, examples and repository map take structural
  inspiration from [RAPTOR Study](https://github.com/AquilaXk/raptor-transit-routing-study).
  Steward's explanations and artwork are original.

Source review dates and scope are recorded in [docs/sources.json](docs/sources.json).
Steward is independent of OpenAI and Anthropic. Original project material is available
under the [MIT license](LICENSE); linked sources retain their own ownership.
