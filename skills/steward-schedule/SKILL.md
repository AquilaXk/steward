---
name: steward-schedule
description: On explicit request, record a dated task or release intention in the passive journal; do not promise reminders, timer execution, calendar synchronization or automatic publishing.
---

# Schedule

Use this skill only for an explicitly requested dated record. Read `.steward/USAGE.md` for the command prefix and toolkit location, then inspect `schemas/journal-entry.schema.json` in that toolkit. Write `{"type":"schedule","data":{...}}` with `title`, `dueAt`, `status` and `members`, then append it with `journal add --file <entry.json>`. Include `Z` or an explicit `±HH:MM` offset in `dueAt`; the runtime's permissive date parser does not enforce that requirement for you. Confirm a timezone only when it cannot be resolved from context.

Read relevant dated entries during the active session. Updates append another record; this release has no schedule `supersedes` field, stable schedule ID or automatic reconciliation view. Use a consistent title, report both record hashes and describe the intended relationship. Do not add unsupported fields or pretend an older pending entry has been overwritten or cancelled by software.

The journal does not wake up, poll, remind, send invitations or publish on a timer. Record preparation separately from actual delivery. Honor the user's authority for any external action. An expired intention is not permission to execute an outdated action.

Input: the requested title, due time, status and members. Result: a dated journal record with its hash and a clear statement that no automatic execution was scheduled.
