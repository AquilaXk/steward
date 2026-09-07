# Recorded state and its limits

The authoritative local records live in `.steward/state/journal/`. Each file contains
one complete entry with version, sequence, record ID, type, timestamp, previous hash,
data and content hash. Readers validate the envelope, typed payload (including internal
verification records), filename identity and entire chain before reporting or appending.

User-writable entry types are decision, question, knowledge, goal, checkpoint, schedule
and handoff. `verification` is reserved to the runner API. This separation prevents
accidental self-attestation through `journal add`; it does not authenticate hostile
code that has direct file or JavaScript module access.

Examples of the record data:

```json
{
  "type": "knowledge",
  "data": {
    "claim": "The parser rejected the malformed sample in the focused test.",
    "basis": "observation",
    "sources": [{ "reference": "test/parser.test.mjs", "checkedAt": "2026-09-07T00:00:00Z" }],
    "expiresAt": null
  }
}
```

```json
{
  "type": "handoff",
  "data": {
    "task": "Review the parser compatibility change.",
    "scope": ["src/parser.mjs", "test/parser.test.mjs"],
    "constraints": ["Preserve the public response schema."],
    "acceptance": ["Show the old and new malformed-input behavior."],
    "evidence": ["Reference the actual verification record here."]
  }
}
```

Decision attribution contains kind (`user` or `delegated`), reference and quote.
A supersede points to the exact old record hash. The target must exist, have the same
type and not already be superseded. Question records also support superseding.
No old record is edited to add a backlink.

A goal can be active, blocked or complete. A complete goal must reference current,
passing verification records checked by the completion gate. This validates the
configured checks, not whether they are a sufficient test of the goal's semantics.

Checkpoints contain summary, next and blockers. The writer enforces a 4 KiB data bound.
Use `checkpoint --file FILE --session-id HOST_SESSION_ID` to bind a checkpoint to the
exact host session. Only its SHA-256 digest is stored in the optional `session` field.
Omit the option only for unscoped records. Named sessions never restore unscoped records
or another session's data; events without a session restore only unscoped records.
If the host session ID is unavailable, do not guess it or promise automatic recovery.
`PreCompact` takes a snapshot of the existing chain head and matching checkpoint. A
snapshot explicitly states `conversationCaptured:false`. No transcript path supplied
by a host is opened by this implementation.

Keep an anchor outside the project to detect truncation:

```sh
node bin/steward.mjs journal anchor --project /absolute/path/to/project > /safe/place/project-anchor.json
node bin/steward.mjs journal verify --project /absolute/path/to/project --anchor-file /safe/place/project-anchor.json
```

Without a previous external reference, a removed suffix can look like a legitimate
shorter journal. An attacker able to rewrite every record can recompute the chain.
Use signed external storage or a reviewed Git history when that threat is in scope.

Records are local, private by default. A saved note may be inserted into model context
on session start, so do not put credentials or unnecessary personal data in it.
