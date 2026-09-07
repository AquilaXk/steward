# Changelog

Package, CLI and plugin manifests share a semantic version. Git tags identify
released source as `vMAJOR.MINOR.PATCH`. Before 1.0, incompatible public CLI or
configuration changes increment the minor version; compatible fixes increment
the patch version. Journal and policy schema versions are independent: a package
release never silently rewrites stored records.

## 0.2.0

- Add native plugin onboarding and a doctor command that separates local wiring
  from observed host behavior.
- Add bounded journal queries with explicit history, expiry and supersession.
- Add managed updates and removal that preserve customized skills and project data.
- Generate Claude skill metadata from shared procedures and reject packaging drift.
- Preserve schedule identity across immutable revisions and reject forked updates.
- Report unused policy rules and remaining audit capacity for the current bundle.
- Synchronize package, CLI and plugin versions through the package check.

This release also includes the previously unreleased public-source preparation:
English and Korean README alignment, artwork, current model guidance, repository
metadata and pinned CI actions. Rename package, CLI, skill, state and trust identities
to Steward without automatically migrating old installations. Validate journal
envelopes, isolate checkpoint restoration by session digest, preflight hook writes
with rollback, and resolve project aliases before trust and host comparisons.

## 0.1.1 — 2026-09-07

Removed unrelated project material, dedicated import tooling, project-specific profiles
and their tests. Documentation and verification artifacts were regenerated for this delivery.

Added native Claude skill installation and `@AGENTS.md` import, preserving existing user
content. Canonical skill folders now match their names. Policy and schedule have explicit
invocation controls; all eight procedures now have tighter triggers and result contracts.
Generated local usage instructions resolve executable and example paths.

Fixed native relative file/patch paths to use the event working directory. Corrected
Claude SessionStart error output so it no longer claims unsupported startup blocking.
The starter verification plan now fails until real checks are configured.

Renamed workflow metadata and model documentation to provider-neutral paths, reviewed
current official guidance for both providers, and expanded supervised evaluation cases
without claiming live runs. Added 17 focused regressions while removing 5 tests belonging
to the removed feature; the local suite now contains 124 passing tests.

## 0.1.0 — 2026-09-07

Initial local policy, journal, verification, host adapters and task-scoped skills.
