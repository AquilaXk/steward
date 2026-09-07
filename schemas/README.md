# JSON editor schemas

Use these files for completion and early feedback in your editor. The executable
validator in `src/schema.mjs` remains authoritative. Both reject unknown fields;
runtime adds cross-record checks, Unicode token checks, UTF-8 byte ceilings and
trust checks that JSON Schema alone does not enforce here. `maxLength` in JSON
Schema counts characters, not bytes.

The schemas contain no remote references beyond the standard dialect identifier.
They do not grant trust or execute commands. Steward itself does not download them.

For VS Code, associate `policy.schema.json` with `.steward/policy.json`,
`verification.schema.json` with `.steward/verify.json`, and `event.schema.json`
with generic event fixtures. `journal-entry.schema.json` describes input to
`journal add`, not the hash-linked envelope stored by the journal.
