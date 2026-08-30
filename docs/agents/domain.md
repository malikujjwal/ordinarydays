# Domain-document convention

This is a multi-package repository, so domain context is routed from the root
`CONTEXT-MAP.md`. Canonical product language remains under `docs/01-product/`; the context map
points agents to the owning package and contract without duplicating either.

Architectural decisions that constrain more than one implementation area belong in
`docs/adr/`. Use a short Markdown record with context, decision, consequences, and status.
Package-local implementation notes may live beside their code, but they must link back to the
canonical product contract or ADR when they introduce shared terminology or constraints.
