# Skill scope

Eight skills are retained. They describe procedures; they are not an agent runtime,
a mandatory chain of thought or eight agents that run on every prompt. All canonical
folders use `procedures/steward-<name>/SKILL.md`. Installation copies those sources into
native discovery locations for manual setups. Marketplace setups load these sources
from the plugin and use `--plugin` to avoid duplicate copies. Administrative skills
carry Codex's explicit-invocation control in `agents/openai.yaml`. Claude installation
and generated plugin skills add `disable-model-invocation: true` for the same two
administrative procedures. The package check verifies generated artifacts against
the canonical sources.

| Skill | Trigger and output | Deliberate boundary |
|---|---|---|
| work | Multi-step authorized task → concrete deliverable and progress | Not required for trivial edits; review-only stays review-only |
| recall | Material prior context → bounded current records and freshness labels | Full-chain validation remains; literal matching is not semantic search |
| decisions | Explicitly confirmed choice → attributed immutable record | An AI proposal is not user approval |
| checkpoint | Context loss or handoff → concise persisted next action | Same-session restore only; no automatic capture of unrecorded conversation |
| verify | Meaningful changed behavior → scoped evidence and actual status | No cosmetic test busywork or weakened green result |
| delegate | Real independent parallel scopes → integrated artifacts | No fictional tools, trivial delegation or overlapping ownership |
| policy | Explicit invocation → reviewed configuration or diagnosis | Does not manufacture digest approval or override native permissions |
| schedule | Explicit invocation → dated passive record | No timer, reminder, calendar integration or automatic publication |

Each description states when to use and when not to use it. Each body names its input
and result. The optional policy/schedule invocation controls are a product choice, not
a claim that the skill standard requires them everywhere. No broad `allowed-tools`,
model pin, context fork or extra SDK is added merely to make the package look complete.

The public-release review tightened source-vs-authority handling in recall, exact
verification-run selection, read/write boundaries in delegation, setup command
resolution and passive schedule formatting. Unscoped checkpoint reuse is explicitly
shared, so a missing session ID cannot be described as task isolation. See the
[per-skill review](MODEL-GUIDANCE.md#skill-review-for-the-public-source-release).

`delegate` now has one responsibility: bounded collaboration. General advice about
creating more skills was removed from that procedure. The shared agreement carries
common authority and communication rules, while detailed steps stay in the relevant
skill. A small default prompt policy still overlaps with the agreement; reduce that
only if measured host runs show unnecessary context or friction.

## Command resolution

Installed procedures read `.steward/USAGE.md` for the absolute runner and example
locations. `checkpoint` and `verify` are CLI subcommands, not standalone executables.
Example entries must be changed to actual user data before they are recorded.
For first-time setup, explicitly invoke `steward-policy`; it resolves the actual
toolkit root, configures project checks, presents the exact approval bundle and
installs the selected host's hooks. Existing project configuration is preserved.

## Upgrade and evaluation

Installers preserve existing skill files. Review skipped files rather than assuming
new behavior reached an older installation. A managed, hash-aware update command is
not yet implemented. Do not hand-edit both native copies independently without recording
which is authoritative; the package sources are the default canonical version.

Use the behavioral cases in `evals/agent-workflow.json` to test actual activation and
non-activation, task completion, unnecessary pauses, appropriate checks and real
side effects. Static file validity alone does not prove that a model chooses the skill
well. No additional planning, review or research skill should be added until repeated
work demonstrates a gap not covered by ordinary host capabilities.
