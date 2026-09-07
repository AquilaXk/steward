# Model and host guidance

Reviewed on **2026-09-07**. This is an engineering mapping, not provider certification.
The official [OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model)
currently identifies GPT-6 Astra. The [Claude model catalog](https://platform.claude.com/docs/en/models/overview)
lists Fable 5.1, Opus 5, Sonnet 5 and Haiku 4.5. Steward does not select a model,
set effort or sampling parameters, call either provider API or implement a model runtime.
`profiles/agent-workflow.json` is documentation metadata, not an API configuration.

## Behavior mapping

OpenAI's guide motivates completing authorized work, keeping skill advice subordinate
to the current task, and choosing useful rather than repetitive verification. These
map to the shared working agreement and the work/verify skills. Parallel work remains
conditional on real collaboration tools and independent scopes.

The [Fable 5.1 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)
supports respecting task scope and communicating progress. Steward explicitly keeps
review-only requests read-only unless edits are requested. The
[Opus 5 guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
informs the restriction against trivial or serial delegation. Provider-specific tuning
must be evaluated in the intended host, not imposed as a universal model setting.

## Native loading

[Codex skills](https://developers.openai.com/codex/skills/) use `.agents/skills` and can
set explicit-only invocation in `agents/openai.yaml`. [Claude skills](https://code.claude.com/docs/en/skills)
use `.claude/skills` and can disable implicit model invocation in frontmatter. The
installer applies those controls only to policy and schedule. Existing customized
files are preserved and require review during upgrades.

[Claude memory guidance](https://code.claude.com/docs/en/memory) documents `@AGENTS.md`
imports from `CLAUDE.md`. Keep the working agreement small and discover skill bodies
only when needed. [Agent Skills](https://agentskills.io/specification) requires a name
matching its parent directory; canonical source directories now meet that constraint.
See [host protocol details](HOSTS.md) for event-specific output behavior.

## Skill review for the public source release

The eight procedures were read against the CLI and runtime contracts, then inspected
independently for realistic setup, recall, supersession, checkpoint, verification,
delegation and passive-schedule requests. This was a read-only scenario review, not
a scored execution of GPT and Claude sessions.

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
