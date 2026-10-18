---
name: steward-verify
description: Run or interpret scoped completion evidence for a meaningful change; skip repetitive broad suites for cosmetic work and never weaken checks to obtain a pass.
---

# Verify

Choose checks that address the actual change and plausible regression risk. A cosmetic change need not run an entire system suite. A policy-engine change needs relevant boundary and host-contract tests. Do not add tests that only restate the implementation.

Read `.steward/USAGE.md` for the command prefix. For a persistent completion gate, inspect the approved `.steward/verify.json` (which may declare optional `exclude` path prefixes for build artifacts), run `verify` (or MCP `steward_verify`, inspecting `.evidence` or `.evidenceHash`), examine statuses and captured output, then run `gate --evidence <returned-evidence-hash>` (or MCP `steward_completion_gate` / `gate` to check the latest run) on the unchanged source. Keep that exact hash in any completed goal; another concurrent run's latest record is not the result you inspected. When cryptographic attestation is requested, sign or verify the evidence hash with `sign-evidence --evidence <hash> --key <priv>` and `verify-evidence --evidence <hash> --verifier <pub>`. The initial plan deliberately fails until real project checks replace it and the new bundle is reviewed. Do not change an approved plan silently.

A passing process proves only its actual checks. Distinguish implementation, integration, deployment and local evidence. Do not convert missing, stale, failed or unavailable checks into success, substitute weaker commands or invent host/model validation.

Input: the changed behavior, acceptance conditions and approved plan. Result: observed statuses, exact evidence scope and material limitations. Deliver after sufficient checks pass; broaden or repeat only for a concrete new reason.
