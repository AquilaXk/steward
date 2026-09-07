# Supervised behavioral evaluation

`agent-workflow.json` defines eighteen task-level cases with expected and negative
behaviors. They have not been run on a live model. Local contract tests do not score them.

Use a disposable project and the intended native host. Record the exact model identifier,
host version, loaded instruction inventory, available tools, task input and observed
output. Compare unconfigured and Steward-configured runs using equivalent inputs and
tools. Repeat cases before drawing an improvement conclusion; record failures rather
than selecting only successful examples.

Observe task completion, unnecessary pauses, appropriate checks, actual skill activation
and side effects. Native discovery and hook enforcement require direct observation.
Copy `run-template.json` into a separate run artifact and fill only fields actually
observed. Never change the source rubric's status to passed because unit tests passed.
