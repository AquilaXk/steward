---
name: steward-policy
description: On explicit request, initialize, review, change or diagnose Steward policy and host setup; never activate a new rule or verification command without authorization.
---

# Policy

Use this skill when the user explicitly asks to set up Steward, change a policy or diagnose an installation. Keep questions to missing choices; perform file edits and command work yourself. Explain the resulting rules and checks in the user's language. Show raw configuration only when needed for review or requested.

## Set up a project

1. Identify the target project and whether the host is Codex or Claude Code from the active session. Resolve the runner before executing anything: use the host-reported plugin root for a marketplace installation, the target's `.steward/USAGE.md` for an existing manual installation, or the verified toolkit checkout for a clone. If plugin root metadata is absent, inspect only ancestors of this loaded skill for a Steward plugin manifest and `bin/steward.mjs`; directory depth differs between hosts. Verify the actual CLI file exists, inspect its `--help`, and check Node 22+ and any target-project runtime pins. Ask only for an unresolved target, host or toolkit location; do not assume a global command.
2. For a marketplace installation, pass `--plugin` to both `init` and `install`. This uses the bundled skills without copying duplicates. For a repository clone, omit `--plugin`. Keep the toolkit at a stable path; after a plugin update or relocation, run `update --project <target> --host <host>` from its verified new root.
3. Run `init --project <target>` with the selected mode. Inspect the existing policy and verification plan. Preserve returning users' files. Discover the project's documented checks and configure the smallest meaningful ones; do not run a full suite or invent commands to fill the initial failing example.
4. Run `trust --project <target>` and explain the exact proposed rules, executable commands, side effects and digest. Obtain authorization for that concrete bundle before `trust --approve <digest>`. Do not manufacture approval; reuse existing authorization when it covers the exact bundle. A policy or command change invalidates earlier trust.
5. Run `install --project <target> --host <codex|claude>` with the same mode, then `doctor --project <target> --host <codex|claude>`. Use `.steward/USAGE.md` for subsequent command locations. Report preserved skill copies when switching from a manual installation; never remove user edits automatically.
6. Complete the host's own permission flow. In a new native session, observe a harmless matching rule, the skill inventory, and the applicable smoke checks in `docs/HOSTS.md`. A command subprocess or `localHealthy` result proves local wiring only. Report native checks as unverified if the current tools cannot observe them.

## Change or diagnose a policy

Use `eval --input <event.json>` to simulate a draft, including one intended match and one nearby non-match in the user's language. Use `report` to compare current-bundle matches, emitted and omitted rules. Never-emitted rules can mean no relevant request, wrong-language matching or a budget omission; zero is not a reason to delete a rule. Keep deny rules distinct from injected text. Propose only the correction supported by the evidence, then follow the exact-bundle review above.

`doctor` distinguishes missing or broken local setup from configured but natively unchecked hooks. It never proves model obedience. `instructions-audit` is a bounded heuristic inventory, not a complete security review.

Keep rule matches precise, test false positives and keep required guidance small. Policy changes invalidate trust. Do not add environment bypasses, convert errors to allow or treat a hook as an operating-system sandbox. Review preserved skill files when upgrading; installation does not overwrite user edits.

Input: the explicit configuration request and reviewed files. Result: a reviewable configuration or diagnosis, its exact trust state and any required host-native verification.
