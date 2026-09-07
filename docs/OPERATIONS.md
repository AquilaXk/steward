# Operations

Use `doctor` after setup or a policy change. It validates trust and the journal,
inventories known instruction files and reports live host verification as false.
Use `instructions-audit` separately before adopting additional skills. Findings name
files and line numbers but remain a heuristic review aid.

Trust records live outside the project under `~/.config/steward/trust/` by default.
`STEWARD_TRUST_HOME` can select an operator-controlled external directory. It cannot
select a directory inside the project. Do not give untrusted code write permission to
that directory. Host hook trust and operating-system permissions are separate controls.

A policy/plan change requires another exact digest review. Relocating a project changes
its identity; review it at the new location. Moving the toolkit requires rerunning the
local hook installer. No model key, provider SDK, background service or network listener
is part of this process.

The audit directory is per project, with one exclusive JSON receipt per invocation.
Reports count prepared rule IDs and denials, never prompt contents. The conservative
retention ceiling is approximately 20,000 receipts; concurrent writers may briefly
overrun the directory-count check. Once full, activation fails explicitly. Archive
receipts outside the project state directory during a quiet maintenance window; there
is no automatic deletion command that might erase incident evidence.

A crash while holding `journal.lock` requires operator recovery. Stop all writers,
verify that no process owns the lock, retain a copy of the state and remove the empty
lock directory. Run `journal verify` with a retained anchor before writing again.
Do not remove a lock merely because another write is taking longer than expected.

Temporary files prefixed `.tmp-` may remain after a crash. They are not accepted as
committed journal entries. Preserve them for investigation and remove them only after
confirming the corresponding writer is not active. Filesystem fsync and atomic install
reduce partial writes but do not constitute a guarantee against all storage failures.

## Updating this installation

This source tree uses `steward`, `bin/steward.mjs`, `.steward/`,
`STEWARD_TRUST_HOME` and `steward-*` skills. Earlier branded installations and trust
records are not automatically loaded or migrated. Inspect and retire old hook
registrations explicitly before activating a new installation; the installer owns
only commands recorded in its current installation receipt.

The toolkit sources are canonical. `init` and `install` preserve existing policy,
verification and skill files. Review the returned `skipped` paths; a successful installer
exit is not a claim that every existing file was updated. Compare the common agreement,
agent-profile metadata, both native skill locations and invocation settings with this
release. Keep user edits; apply intentional updates explicitly. Review the bundle again
when policy or verification commands change. Generated `.steward/USAGE.md` and exact
installer-owned hook commands can be refreshed after relocating the toolkit.

Hook installation preflights all target paths and serializes installers using
`.steward/install.lock`. A caught write failure restores completed file writes and
reports `INSTALL_FAILED`; empty directories may remain. If restoration itself fails,
`INSTALL_RECOVERY_REQUIRED` names the paths needing operator recovery. A crash or
forced termination is not a transactional rollback: inspect files and confirm that no
installer is running before removing a leftover lock. No hostile filesystem race
protection is claimed.

There is no automatic three-way skill merge, managed-file digest updater or uninstall
command in this release. Preserve installation receipts for deliberate recovery.

## Project state

Keep each project boundary explicit. Journal reads scan and validate the full chain,
including typed payloads. Checkpoint restoration selects only the matching session
digest; unscoped events select only unscoped records. Use `checkpoint --file FILE
--session-id HOST_SESSION_ID` when saving for a named session. Keep checkpoints concise and
verify their task and source freshness before using them.

Schedule updates append records; they do not supersede entries through a stable schedule
ID. Knowledge expiry must be checked by the caller. There is no background reminder
service or automatic retention deletion. Plan recovery and retention before large-scale use.
