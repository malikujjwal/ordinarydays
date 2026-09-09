# Agent instructions

Follow the product, implementation, design, coding, testing, and completion contracts under
`docs/` for the area being changed. Preserve user-owned working-tree changes and use the
repository's existing verification commands before committing.

Implementation is multi-agent. The parent session is the supervisor: it does not be the
primary writer for product, code, test, or canonical-doc changes. Scout the path, oracle
advises the direction, a worker implements, and a fresh-context reviewer checks a pinned
revision. Direct parent edits during implementation are only small, stated interventions.
Exceptions: questions, recaps, and an explicit "do this yourself". Details: [the project
workflow guide](docs/agents/workflow.md).

## Agent skills

- Project workflow and skill selection: `docs/agents/workflow.md`
- Issue-tracker convention: `docs/agents/issue-tracker.md`
- Triage-label convention: `docs/agents/triage-labels.md`
- Domain-document and ADR convention: `docs/agents/domain.md`
- Repository context map: `CONTEXT-MAP.md`
