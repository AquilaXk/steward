# Operations

Use `doctor --host codex` or `doctor --host claude` after setup or a policy change.
It validates trust and the journal, inventories instruction files and checks the
four registered handlers, their command paths, matchers, synchronous configuration,
skill files and runner instructions. Unrelated hook entries are preserved.
`localHealthy: true` means these local checks passed; `healthy` and
`liveHostVerified` remain false because native invocation is unchecked. Exit 1
means missing or broken local setup (or a trust/journal error). Without `--host`,
at least one host must be configured and every recorded installation must pass.
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
Reports count prepared rule IDs and denials, never prompt contents. The
`current` section groups matches, emissions and omissions by the exact current
policy/verification bundle. An old receipt with a reused rule ID does not establish
that the new rule ran. `neverEmitted` covers injection rules only; a deny rule can
work without emitting context. `retention.remaining` gives the remaining receipt
capacity. No history is reported as no observations, not as a successful live check.
The conservative
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

Marketplace installations use the plugin's eight bundled skills. Pass `--plugin`
to both `init` and `install` so they configure project state and hooks without making
duplicate native skill copies. The commands leave earlier manual copies untouched;
inspect and deliberately retire those copies if switching installation modes.

After updating the toolkit or native plugin, run `update --host <host>` from its
current location. This retains the installation mode and refreshes absolute runner
paths and `.steward/USAGE.md`. Project skills created by this installer have hashes
in `.steward/install-<host>-skills.json`; update replaces only unchanged owned files.
A customized owned skill stops the update before activation with `INSTALL_CONFLICT`.
Reconcile the reported file deliberately before retrying. Existing unowned files
remain skipped; older receipts do not retroactively establish file ownership.

Before removing the native plugin, run `uninstall --host <host>` with the local
runner. It removes exact receipt-owned hook commands and unchanged managed skills,
and reports customized files retained. Policy, verification plans, journal, trust,
shared `AGENTS.md` content and unrelated handlers remain. Claude's exact generated
import block is removed only when the receipt records its ownership. Then remove
the plugin through the host's plugin manager. Repeated uninstall is a no-op when
the receipt is absent. Empty skill directories may remain.

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

There is no automatic three-way merge or network updater. Preserve installation
receipts until removal; a receiptless directory is never assumed to be owned.

## Project state

Keep each project boundary explicit. Journal reads scan and validate the full chain,
including typed payloads. Checkpoint restoration selects only the matching session
digest; unscoped events select only unscoped records. Use `checkpoint --file FILE
--session-id HOST_SESSION_ID` when saving for a named session. Keep checkpoints concise and
verify their task and source freshness before using them.

Use `journal query --type knowledge --text <term> --limit 20` for bounded recall.
The CLI validates the whole chain, then returns newest matches, their total and a
truncation flag. Limits are 1–100 (default 20); this bounds returned records, not
storage scanning or total serialized bytes. It performs literal case-insensitive
matching over data fields, without embeddings or a model. Expired knowledge and
superseded records are excluded unless `--history` is explicit. Returned freshness
labels are not a claim that an external source was rechecked.

New schedules can use `id` and `supersedes: null`. A revision preserves that ID and
references the latest hash; reused initial IDs, changed identities and forks fail.
`journal query --type schedule --record-id <id>` returns the current revision;
`--history` includes its past records. Legacy records without IDs remain readable.
There is no background reminder service or automatic retention deletion.

## Versions

Use `version` or `--version` to print the package version. Package metadata is the
CLI authority; `npm run check` verifies both plugin manifests, the lockfile and the
current [changelog](../CHANGELOG.md) entry. Source releases use `vMAJOR.MINOR.PATCH`
Git tags on merged commits. Package versions do not migrate journal or policy
schemas. Review the changelog before applying an update.
