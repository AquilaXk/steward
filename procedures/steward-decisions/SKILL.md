---
name: steward-decisions
description: Record an explicitly confirmed user decision or its superseding change in the journal; do not promote suggestions, assumptions or ambiguous replies to decisions.
---

# Decisions

Read `.steward/USAGE.md` for the command prefix and absolute example directory. Use the `decision.json` shape there, replacing every fixture value with the actual statement and confirmation source. Append it with `journal add --file <entry.json>` only when a durable decision is warranted.

When a decision changes, append a new entry whose `supersedes` is the previous record hash. Preserve the old record. Update affected references within the authorized task, or identify references still needing review. Do not treat an AI proposal as user confirmation.

Authority fields provide attribution, not cryptographic proof of identity. Local write access can forge them. Hash links detect certain changes but do not establish the truth of the recorded decision.

Input: the confirmed statement, source and optional previous record hash. Result: an appended decision and its record hash, or an explicit unresolved question when confirmation is missing.
