---
name: steward-recall
description: Retrieve relevant saved decisions, knowledge or unresolved questions when prior context affects the task; skip unrelated memory sweeps and ordinary stateless requests.
---

# Recall

Read `.steward/USAGE.md` for the local command prefix, then use `journal list` and narrow the returned records to the task. This command currently returns the whole journal; the instruction to narrow is not a claim of indexed retrieval. Do not repeat a complete read after every edit.

Check supersede links, source dates and knowledge expiry. A confirmed user decision can define the required behavior; current code shows what is implemented. If they disagree, report that gap instead of silently treating implementation as authority. Verify changing external claims against current original sources using the host's available documentation tools. Expiry is a field to inspect, not an automatic exclusion enforced by this CLI. Fetch only material missing context and seek contradictory evidence as well as support.

A direct code observation, formal proof and changing external claim need different support. Avoid a universal two-source requirement. Another model's output is not independent proof. Record a material unresolved question with its assumptions; do not invent context, URLs or completed work.

Input: the current question and saved records. Result: relevant facts with their source and freshness, separating settled decisions, assumptions and open questions.
