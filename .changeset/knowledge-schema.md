---
"@relayroom/db": patch
---

Add the Project Knowledge substrate: `knowledge`, `knowledge_validation`, `knowledge_audit`, and `recall_log`, with migration `0015`.

This is the storage layer for 0.5.0's retrieval loop - durable project facts an agent can look up before acting, and the ledger that records how each one earned trust. Nothing reads or writes these tables yet.

The migration installs `pg_trgm` and a GIN trigram index over `title || ' ' || body`, which is what makes the `%`-operator similarity search usable rather than a sequential scan. It also creates a unique index on `(project_id, id)` now rather than later: the composite foreign key that keeps one project's CI from attesting another project's knowledge references it, and adding the index in a subsequent migration would mean two migrations where one will do.
