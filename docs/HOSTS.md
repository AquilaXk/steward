# Native host integration

Reviewed on 2026-09-07 against [Codex hooks](https://developers.openai.com/codex/hooks)
and [Claude Code hooks](https://code.claude.com/docs/en/hooks). Protocol tests are local;
neither native application was launched for the delivery run.

## Files and discovery

Both hosts can install the `steward@steward` marketplace plugin, which exposes the
eight canonical skills. Project setup then runs `init --plugin` and
`install --host <host> --plugin` from the actual cached toolkit path. There are no
automatically activated plugin hooks: project policy and verification commands are
reviewed before local hook registration. Native trust is still required.

`init` installs the eight canonical skill sources under `.agents/skills/steward-*`.
`install --host codex` merges `.codex/hooks.json`. `install --host claude` merges
`.claude/settings.local.json`, installs native `.claude/skills/steward-*` copies and
adds `@AGENTS.md` to `CLAUDE.md` without replacing user notes. An old exact pointer
written by this installer is replaced with the native import.

Policy and schedule use explicit invocation controls on new manual installations: Codex metadata sets
`allow_implicit_invocation: false`; the Claude copy sets `disable-model-invocation: true`.
Other skills remain available for task-triggered selection. These are invocation controls,
not authorization grants. Existing files are preserved and reported as skipped, including
customized skills whose invocation controls may differ.
Codex plugins load `procedures/` with their `agents/openai.yaml` controls. The Claude
plugin loads `.claude-plugin/skills/`, generated from the same procedures with native
frontmatter controls. Run `npm run build:skills` after editing a procedure; `npm run
check` rejects stale generated files. Skill selection never authorizes a mutation.

The installer records absolute executable/toolkit paths and generated usage instructions.
Rerun it after relocation. It merges four synchronous command handlers with a ten-second
host timeout, preserves unrelated handlers, and only replaces exact commands recorded
by its own receipt. It does not modify native host trust or grant permissions.

## Events

| Event | Codex output | Claude output |
|---|---|---|
| SessionStart | Status/checkpoint context; `continue:false` on denial | Status/checkpoint context; error on stderr and exit 2 on failure, **cannot block startup** |
| UserPromptSubmit | Context or exit 2 with reason on stderr | Context or exit 2 with reason on stderr |
| PreToolUse | Context or `permissionDecision:deny` | Context or `permissionDecision:deny` |
| PreCompact | Persist existing state, then `{}`; `continue:false` on failure | Persist existing state, then `{}`; `decision:block` and exit 2 on failure |

The inability to block Claude SessionStart is not silently represented as success.
Later prompt/tool handlers still validate their own trust and policy. Their protection
also depends on the host invoking them and honoring the documented output.

File-tool paths resolve relative to the event's validated `cwd`, defaulting to the
selected project root only when the host omits `cwd`. Absolute paths remain absolute.
Patch source and move-destination paths are both inspected. This is lexical path
normalization, not symlink resolution or complete mediation of arbitrary shell writes.

## Required native smoke test

In a disposable project, record the exact host version. Review the plan and digest,
install hooks, finish native trust review and start a new session. Observe the common
agreement and native skill inventory. Confirm a harmless denied file edit does not run,
including an edit launched from a nested working directory. Save a checkpoint, compact,
and inspect both persistence and restoration. Test invalid trust, malformed input and a
hook that cannot start; record the actual host behavior instead of inferring it.

A disabled hook, missing executable, crash, timeout or uncovered tool can bypass the
interception layer. Steward cannot stop a host from inside a process that never ran.
Use actual OS isolation where the required boundary exceeds a cooperative local hook.
`doctor` deliberately reports `liveHostVerified:false`; local success does not promote it.

## Generic interface

```json
{"event":"tool","text":"npm install","tool":"shell","paths":[],"sessionId":null}
```

Send JSON to `hook --host generic --project <directory>` via stdin or `--input`.
A denial exits 2. The caller owns execution and must not execute a denied action.
`eval` evaluates a draft without activation and labels the output as a simulation.
