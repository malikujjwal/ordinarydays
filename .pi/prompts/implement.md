---
description: Orchestrated implementation (scout → oracle → worker → reviewer)
argument-hint: "<outcome>"
---
Implement $ARGUMENTS using the repository's multi-agent implementation loop
in docs/agents/workflow.md.

You are the supervisor, not the writer. Do not edit product code, tests, or
canonical docs yourself except a small review fix with a stated reason.

1. Scout the contracts and one real path. No edits.
2. Oracle advises direction and material tradeoffs from that evidence. No edits.
   Wait for that direction before a worker writes.
3. Worker implements one bounded behavior with tests.
4. Fresh-context reviewer checks a pinned revision.
5. Report behavior, evidence, and remaining gates. Do not merge, deploy, or
   push unless asked.
