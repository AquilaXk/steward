# Steward local verification

This is the public-source preparation revision, package version 0.1.1.
Environment: macOS arm64, Node v22.16.0, npm 10.9.2.
The runtime matches the Node 22 project pin and was obtained from the official
distribution with its published SHA-256 checked.

| Command | Exit | Observed result |
|---|---:|---|
| `npm run check` | 0 | Module syntax, JSON, package identity, skill metadata and local links |
| `npm test` | 0 | 136 passed; 0 failed, cancelled, skipped or todo |
| `npm run demo` | 0 | Three synthetic arithmetic tests; policy denial; checkpoint recovery; source-change rejection |
| Skill Creator structural validator | 0 | All eight canonical skills have valid names, frontmatter and complete bodies |

Raw suite output is in `test-results.tap`. Check and demo output is retained in
the corresponding JSON files. `delivery.json` records the collection timestamp.
The initial eleven regression cases failed before their fixes and passed afterward.
A further project-alias regression failed before the path-identity correction and
passed afterward. The final suite includes all twelve additions.

Existing host adapter tests and the demo now save checkpoints for their named
sessions. They retain assertions for compaction persistence, restored contents and
session anonymization. New cases reject cross-session and unscoped substitution.

Not run: live Codex or Claude sessions, model APIs, supervised behavioral cases,
Linux/Windows and Node 24 in this local run. The public repository's Actions page
records the separate current-commit CI matrix. No actual user hook installation or
service deployment was performed. Hook CLI subprocess tests are not live host enforcement evidence.

The original evidence directory was copied outside this project before regeneration.
It was not relabeled as current output. New manifests hash the current files:
`source-manifest.json` excludes `evidence/`; `manifest.json` excludes itself.
The reference scan covers file paths and UTF-8 contents, including hidden files.
Manifests are integrity records, not signatures or independent author authentication.

The README and six skill procedures were refined for the public source release.
An independent read-only scenario inspection informed the changes; no model API
evaluation was performed. The structural skill validator used Python 3.14.6 and
PyYAML 6.0.3 in a temporary tooling environment, not a project runtime dependency.
