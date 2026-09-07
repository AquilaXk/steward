# Policy contract

The runtime validator is in `src/schema.mjs`. The editor schema is in
`schemas/policy.schema.json`. Runtime cross-field invariants are stricter than basic
JSON shape validation; `eval` and `trust` both run them.

Every policy has version 1, a byte/rule budget, and at most 256 rules. Unknown fields,
duplicate rule IDs, unsupported effects, invalid trigger combinations and dead word
predicates are errors. An empty rules array is valid; a missing policy file is not.

```json
{
  "version": 1,
  "budget": { "bytes": 6000, "rules": 12 },
  "rules": [
    {
      "id": "use-pnpm",
      "on": ["tool"],
      "effect": "inject",
      "priority": 100,
      "required": false,
      "body": "Use the pnpm equivalent for this project.",
      "match": { "tools": ["shell"], "wordsAny": ["npm"] }
    }
  ]
}
```

`on` selects prompt, tool or session. Denial is allowed for prompt and tool rules;
session rules only inject. A rule can have an effect of `inject` or `deny`.
`required` means injected guidance must fit; it is false for a denial.

`textAny` is case-insensitive literal substring matching. `wordsAny` compares normalized
Unicode token sequences, so `npm` does not match `pnpm`. `pathPrefixes` compares literal
project-relative path segments, so `memory` does not match `memory-old`. Paths and tools
are tool-event predicates. An `always:true` match may name tools, but cannot also have
content predicates. Omit tools to address all tools. Tool names do not accept wildcards.

The canonical aliases are:

| Native names | Canonical name |
|---|---|
| Bash, shell_command, exec_command, shell | shell |
| Edit, Write, apply_patch | file.write |
| Read, read_file | file.read |

Other names are matched case-insensitively as exact names. The generic interface
normalizes supplied file paths too. The pure engine expects a normalized event.
A patch move includes both old and new paths. Unknown patch envelopes are rejected.

There is intentionally no arbitrary JavaScript regex matcher. This avoids introducing
user-supplied backtracking expressions into the synchronous hook path. It also means
legacy regular expressions need an explicit rewrite, not a best-effort conversion.

A denial refers to the original matching rule regardless of the guidance budget.
Optional guidance that does not fit is omitted with `byte_budget` or `rule_limit`.
If required guidance does not fit, nothing is emitted and the event is denied.
Session status and checkpoint data use a separate bounded envelope; ordinary prompt
and tool context are wholly covered by the rule budget.

## Things predicates cannot prove

A shell command may call a script, expand variables, launch another executable or
change directories. Steward does not parse shell semantics or execute a preview.
File-path policies for `file.write` do not catch arbitrary shell writes. Tool input
fields outside the known adapter schema may not be included in matching. Write explicit
host policies and use an OS sandbox where actual isolation is required.

Review a new catalog with `eval`. Approve its digest only after reading the policy and
verification plan. The default catalog contains guidance, not a universal danger blacklist.
