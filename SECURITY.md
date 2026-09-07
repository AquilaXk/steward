# Security boundaries

Steward provides local guardrails and inspectable evidence. It is not a sandbox,
an authentication system or a guarantee that an AI agent will follow a rule.

## What the running program enforces

Malformed input, an unreadable or invalid policy, a missing trust record or a changed
bundle prevents an allow decision. Denials are evaluated before optional context
allocation. Required guidance cannot be silently dropped. Runtime validation rejects
unknown fields, duplicate IDs, dead match combinations and arbitrary regex predicates.

The state writer rejects control paths that escape the selected root or cross a
symlink below it. Atomic file installation avoids accidental overwrites. A directory
lock serializes cooperating journal writers; a hash chain detects many edits and gaps.
The completion gate checks captured outputs, source, plan, runtime and evidence age.

## What remains outside that boundary

The host can disable, ignore, fail to start or time out a hook. A pre-execution crash
or an unsupported tool cannot be prevented by code that never receives control.
The host's permissions and sandbox remain authoritative. Live host behavior was not
verified in this delivery environment.

String and path matching do not understand shell semantics. Equivalent commands,
external scripts, aliases, encodings and shell writes can bypass a narrow predicate.
There is no guarantee of stopping prompt injection or malicious code. Retrieved files
and saved notes remain data to evaluate, not fresh authority.

The same operating-system user can modify runtime code, forge local trust, rewrite
state or recompute a complete hash chain. Decision authority fields are claims about
provenance, not a signed user identity. An external anchor is needed to detect a
removed suffix, and a protected external history is needed against full rewrites.

Symlink checks are best-effort local checks and do not eliminate hostile TOCTOU races,
hard-link tricks or mount changes. Verification commands run with local user privileges;
`node -e` and explicitly selected shells are powerful programs. A timeout kills the
direct process, not necessarily every descendant on every platform.

## Data handling

The core does not make network requests or read provider API keys. Prepared receipts
omit prompt text, tool arguments, file contents and raw session IDs. Project paths are
represented by hashes. Checkpoint notes can enter model context through the host, whose
own data handling applies.

Verification stdout/stderr and journal text are local plaintext. They can contain
confidential source details or secrets printed by project tests. They are not encrypted.
`.steward/state/` is ignored by generated Git rules. Do not archive that directory into
a public repository without a content review. A subprocess can read the filesystem or
make network requests despite its reduced environment.

## Reporting an issue

Use [private vulnerability reporting](https://github.com/AquilaXk/steward/security/advisories/new)
for suspected vulnerabilities. Include the affected version, runtime and a minimal
synthetic reproduction. Do not include real credentials, private prompts or confidential
journal records. Use public issues only for non-sensitive bugs and feature requests.

## Integration and verification limits clarified in 0.1.1

Claude SessionStart cannot block startup. A reported error is not proof that the host
stopped; supported prompt/tool events must enforce their own checks. Lexical path
matching is not full symlink resolution and does not identify arbitrary file writes
inside shell commands. Native host permissions and OS isolation remain separate.

The initial verification plan intentionally fails until configured, but an operator can
still approve an inadequate command. Zero exit status is not semantic correctness.
Direct-child timeouts do not guarantee all spawned descendants have stopped. Journal
reads validate typed payloads and envelope identity as well as the chain. Checkpoint
restoration matches the session digest and never substitutes another session's record.
These checks do not authenticate a writer who can rewrite the full chain.
