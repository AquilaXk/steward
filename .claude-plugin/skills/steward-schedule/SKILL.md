---
disable-model-invocation: true
name: steward-schedule
description: On explicit request, record a dated task or release intention in the passive journal; do not promise reminders, timer execution, calendar synchronization or automatic publishing.
---

# Schedule

Use this skill only for an explicitly requested dated record. Read `.steward/USAGE.md` for the command prefix and toolkit location, then inspect `schemas/journal-entry.schema.json` in that toolkit. Write `{"type":"schedule","data":{...}}` with `title`, `dueAt`, `status` and `members`, then append it with `journal add --file <entry.json>`. Include `Z` or an explicit `±HH:MM` offset in `dueAt`; the runtime's permissive date parser does not enforce that requirement for you. Confirm a timezone only when it cannot be resolved from context.

For a new schedule, include a stable `id` (letters, digits, dots, underscores or hyphens; at most 128 characters) and `supersedes: null`. Query `journal query --type schedule --record-id <id>` before revising. Append the same ID with `supersedes` set to the current record hash and the requested status or due time. The CLI rejects a reused initial ID, a changed revision ID or a fork from an already superseded record. Use `--history` to inspect past revisions. Old records without IDs remain readable; do not invent a revision link that the schema cannot represent.

The journal does not wake up, poll, remind, send invitations or publish on a timer. Record preparation separately from actual delivery. Honor the user's authority for any external action. An expired intention is not permission to execute an outdated action.

Input: the requested title, due time, status and members. Result: a dated journal record with its hash and a clear statement that no automatic execution was scheduled.
