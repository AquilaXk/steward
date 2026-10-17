# Model and host guidance

Reviewed on **2026-10-17**. This is an engineering mapping, not provider certification.
Official [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
and the [Claude model catalog](https://platform.claude.com/docs/en/models/overview)
classify capabilities across reasoning, coding, and fast execution tiers (`tier-reasoning`,
`tier-coding`, `tier-fast`). Steward does not pin a specific model identifier,
set effort or sampling parameters, call provider APIs, or implement a model runtime.
`profiles/agent-workflow.json` is documentation metadata, not an API configuration.

## Behavior mapping

Official reasoning and coding guidance motivates completing authorized work, keeping skill
advice subordinate to the current task, and choosing useful rather than repetitive
verification. These map to the shared working agreement and the work/verify skills.
Parallel work remains conditional on real collaboration tools and independent scopes.

Provider prompting guidance supports respecting task scope, communicating progress, and
restricting trivial or serial delegation. Steward explicitly keeps review-only requests
read-only unless edits are requested. Provider-specific tuning must be evaluated in the
intended host, not imposed as a universal model setting.

## Native loading

[Codex skills](https://developers.openai.com/codex/skills/) use `.agents/skills` and can
set explicit-only invocation in `agents/openai.yaml`. [Claude skills](https://code.claude.com/docs/en/skills)
use `.claude/skills` and can disable implicit model invocation in frontmatter. The
installer applies those controls only to policy and schedule. Existing customized
files are preserved and require review during upgrades.

[Claude memory guidance](https://code.claude.com/docs/en/memory) documents `@AGENTS.md`
imports from `CLAUDE.md`. Keep the working agreement small and discover skill bodies
only when needed. [Agent Skills](https://agentskills.io/specification) requires a name
matching its parent directory; canonical source directories meet that constraint.
See [host protocol details](HOSTS.md) for event-specific output behavior.

## Skill review for the public source release

The eight procedures were read against the CLI and runtime contracts, then inspected
independently for realistic setup, recall, supersession, checkpoint, verification,
delegation and passive-schedule requests. This was a read-only scenario review, not
a scored execution of live provider sessions.

| Procedure | Review outcome |
|---|---|
| work | Keep task completion, progress and steering; no mandatory skill pipeline |
| recall | Separate confirmed requirements from observed code; verify changing claims |
| decisions | Keep exact attribution and immutable supersession |
| checkpoint | State shared unscoped behavior; require task checks before reuse |
| verify | Bind the gate and completed goal to the inspected run's exact evidence hash |
| delegate | Declare read/write and external-effect authority; accept observed source identity without inventing Git revisions |
| policy | Resolve the actual toolkit for first setup; preserve exact bundle approval |
| schedule | Require an explicit timezone; preserve stable IDs and supersede only the current revision |

These changes address concrete instruction gaps. No model parameter, mandatory
verification subagent, automatic scheduler or API integration was added. Existing
explicit invocation controls for policy and schedule are retained. The documented
unscoped-checkpoint and passive-schedule limits remain visible. Bounded recall and
immutable schedule revisions are enforced by the CLI and tested at the journal boundary.

## Validation boundary

Local software tests exercise schemas, decisions, persistence, path handling,
configuration installation and CLI output. They do not measure model judgment,
automatic skill selection quality or native host enforcement. The nineteen cases in
`evals/agent-workflow.json` remain `not_run_on_live_model` as a complete rubric. A
[bounded native smoke](../evidence/0.2.0.md#native-observations) exercised Codex recall
and native discovery, and recorded failed enforcement and unavailable Claude model
execution. Record exact versions, inputs, tool availability and failures before
claiming a comparative improvement. Source URLs and dates are indexed in `sources.json`.
