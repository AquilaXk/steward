# Verification and completion

`.steward/verify.json` declares exact argv arrays, descriptions, per-command timeouts
and an evidence freshness window. The plan is part of the trusted bundle. Editing it
invalidates trust before any command runs. A plan with no checks is rejected. The initial plan deliberately fails with an
unconfigured message until actual project checks are specified and reviewed.

```json
{
  "version": 1,
  "maxAgeSeconds": 86400,
  "checks": [
    {
      "id": "focused-tests",
      "description": "Run the parser behavior and consumer contract tests.",
      "argv": ["node", "--test", "test/parser.test.mjs", "test/contract.test.mjs"],
      "timeoutMs": 30000
    }
  ]
}
```

This example is a plan shape, not a claim that these files exist in your project.
Use actual project paths. `node` resolves to the current Node executable; other command
names use the filtered environment's PATH. Arguments are not interpolated by a shell.
An explicit `sh`, `bash`, `cmd`, `powershell` or similar executable still runs a shell
because the operator expressly selected it in the reviewed plan.

The runner preserves every required check and assigns pass, fail or unavailable.
A policy/trust failure blocks execution and produces an explicit CLI error before a
verification record is created. Nonzero exit, signal, timeout and excessive output
are failures. Missing executables are unavailable. It never substitutes a different
command, model or weaker test.

Captured stdout and stderr are kept under `.steward/state/checks/`, along with their
hashes in the verification journal entry. The combined spawn capture is limited to
1 MiB. A source hash is calculated before and after running; changes during verification
prevent a successful result even when every command exits zero. File executable bits
are included: removing execute permission invalidates previous evidence. Evidence
created before this snapshot change requires a new verification run.

`gate` requires a passing record, the approved plan's check IDs in order, the same
bundle digest, source digest and Node/platform/architecture, an age within the plan's
window, and unchanged captured output. It returns a local verification scope explicitly.
Dependencies under node_modules, remote services, hardware state and deployment state
are outside the source snapshot. Pin dependencies and test external interfaces separately
when they matter to the change.

A command that exits zero while testing nothing is still a bad acceptance check. The
operator owns the meaning and sufficiency of the plan. Steward records what happened;
it does not infer proof of product correctness from an arbitrary successful process.

The package's own local test suite covers engine edge cases, malformed inputs,
real CLI encoding, audit accuracy, trust changes, journal integrity and contention,
verification failures, stale source and altered output. See the recorded delivery run
under `evidence/` rather than assuming a CI badge means those tests ran on every host.

## Remaining operational limits

The source snapshot excludes only root `.git`, root `node_modules`, Steward state and
installation receipts. Nested dependency or build directories can cause unnecessary
changes or hit the 128 MiB / 20,000-file limits. No configurable snapshot scope exists
yet. Add only reviewed, explicit rules when implementing one; never silently omit a
path to make evidence pass. Symlink target contents are not captured as ordinary files.

The runner bounds the direct subprocess. It does not implement cross-platform process
group supervision for all descendants. A trusted command that starts background children
can outlive its parent. Native sandboxing, dependency/runtime reproducibility and
external service verification remain the operator's separate responsibilities.
