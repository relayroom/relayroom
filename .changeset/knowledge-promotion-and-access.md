---
"@relayroom/shared": patch
"@relayroom/db": patch
---

Add a request-context-free project access decision, and the knowledge promotion transaction.

`decideProjectAccess` answers "may this member do this here" from three facts the caller already has - org role, ban timestamp, and stored grant - and returns a reason rather than a message, so the dashboard can translate it and the MCP server can map it to a status code. The rule that an org owner or admin is an effective project owner without any stored grant travels with it; that rule lived only in the web helper, and a naive level comparison would have locked those users out of projects they administer. A `project_access.level` outside the known set is treated as no grant rather than trusted, so a leftover value cannot be read as authority.

`recordKnowledgeSignal` is the single implementation of the promotion ledger. It locks the entry, records the signal, re-counts, updates only from the expected state, and writes an audit row **only when the state actually changed** - promoting something already promoted must not add a second entry to a ledger whose purpose is to say when things changed. Promotion counts distinct issuers, so a hundred CI runs are one voice. The tenant boundary is enforced inside the function: an entry belonging to another project is answered exactly as a nonexistent one, because on a path a project's CI secret can reach, confirming that an id exists is itself a disclosure.
