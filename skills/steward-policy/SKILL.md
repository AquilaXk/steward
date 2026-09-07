---
name: steward-policy
description: On explicit request, initialize, review, change or diagnose Steward policy and host setup; never activate a new rule or verification command without authorization.
---

# Policy

Use this skill when the user explicitly asks for Steward configuration or diagnosis. Native installers make it explicitly invoked rather than automatically selected. Read `.steward/USAGE.md` for command locations once initialized. For first setup, locate the supplied toolkit's `bin/steward.mjs`, inspect its `--help` and use that actual path; do not assume a globally installed command or guess the toolkit location.

Run `init` for setup, inspect `.steward/policy.json` and `.steward/verify.json`, then inspect `trust`. Configure real project checks instead of retaining the deliberately failing placeholder. Approval of an exact bundle is a separate setup decision; do not manufacture user approval. Existing authorization does not need to be requested again for every routine task.

Use `eval --input <event.json>` to simulate a draft. `doctor` checks local trust and journal state, not live host safety; `report` counts prepared output, not model obedience. `instructions-audit` is a bounded heuristic inventory, not a complete security review.

Keep rule matches precise, test false positives and keep required guidance small. Policy changes invalidate trust. Do not add environment bypasses, convert errors to allow or treat a hook as an operating-system sandbox. Review preserved skill files when upgrading; installation does not overwrite user edits.

Input: the explicit configuration request and reviewed files. Result: a reviewable configuration or diagnosis, its exact trust state and any required host-native verification.
