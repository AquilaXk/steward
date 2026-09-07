---
name: steward-recall
description: Retrieve relevant saved decisions, knowledge or unresolved questions when prior context affects the task; skip unrelated memory sweeps and ordinary stateless requests.
---

# Recall

Read `.steward/USAGE.md` for the local command prefix, then use `journal query --text <task-term> --limit 20`, optionally filtering with `--type`. It returns newest matching records, a total and a truncation flag after validating the entire hash chain. Narrow a truncated query rather than treating the first page as complete. Use `--record-id` for a schedule and `--session-id` for an exact checkpoint session. Do not repeat a complete read after every edit.

Expired knowledge and superseded records are excluded by default; use `--history` to investigate conflicts, retaining the returned expiry and supersession labels. A confirmed user decision can define the required behavior; current code shows what is implemented. If they disagree, report that gap. Verify changing external claims against current original sources using the host's available documentation tools. Non-expired does not mean verified: inspect source dates and the recorded basis. Fetch only material missing context and seek contradictory evidence as well as support.

A direct code observation, formal proof and changing external claim need different support. Avoid a universal two-source requirement. Another model's output is not independent proof. Record a material unresolved question with its assumptions; do not invent context, URLs or completed work.

Input: the current question and saved records. Result: relevant facts with their source and freshness, separating settled decisions, assumptions and open questions.
