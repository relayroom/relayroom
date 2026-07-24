# @relayroom/db

## 0.5.1

## 0.5.0

### Minor Changes

- c791ead: Project Knowledge: turn the message stream into a knowledge layer agents read before they act, and measure whether it compounds.

  Between runs, nothing accumulated. One agent worked out how migrations run in this repo and said so in a thread; the thread closed; next week another agent asked the same question, because the answer was sitting somewhere nobody re-reads. This release closes that loop on the Postgres you already own.

  Agents `recall` validated project facts before non-trivial work and `learn` durable ones they discover. Closed threads are distilled into candidate entries automatically. Recurring failures become proposed knowledge and playbook changes a human approves. Trusted facts are served back in the playbook every agent reads. The dashboard reports whether repeat errors are actually falling.

  The property that makes this safe rather than merely convenient is that **an agent can never promote its own claim**. An entry becomes trusted only when either a configurable number of distinct issuers support it, or the project's owner deliberately confirms it, and in both cases only while nothing has contradicted it. The whole of CI counts as a single issuer, so a hundred green runs cannot carry a claim across on their own: the threshold exists to stop an automated system holding a signing key from deciding truth by itself, not to overrule the person who owns the project. A contradiction demotes. Automation widens what gets captured, never what gets trusted, so a wrong fact cannot amplify as fast as a right one.

  This is a typed, provenance-tracked knowledge table, not a semantic or temporal graph. Relationship modeling is not built here and the feature is not named as though it were.

### Patch Changes

- 5b6705f: Add the durable extractor marker and a redaction-patterns config field, migration `0018`.

  `project.knowledge_dirty_at` is the marker the extractor sweeps on - set when a thread closes, cleared only if it still holds the value the sweep snapshotted. If the thread re-closes mid-sweep the marker takes a new value and the old-keyed clear misses, so the second close survives to the next sweep; that miss is the whole point of a durable marker. `knowledgeConfig` gains `redactionPatterns` for the per-project denylist the extractor and `learn` apply before writing (`retentionDays` was already in the type).

  One trap is documented at the schema and in the tests: the clear must compare the marker at full precision. A JS `Date` carries milliseconds, the column stores microseconds, so reading the marker into a `Date` and writing it back into the `WHERE` never matches - the clear misses and the project stays dirty forever. The sweep must snapshot the marker as text or reference the column within one transaction, never round-trip through `Date`.

- 2f5f75d: Add the CI attestation schema: `project` attest-secret columns, `knowledge_check_map`, `knowledge_nonce`, migration `0016`.

  This is the storage for the non-agent promotion channel. The secret is two-slot (current and previous) so rotating it does not break CI signatures already in flight. `knowledge_check_map` records which CI check may attest which knowledge entry, and `knowledge_nonce` is per-project replay defense.

  `knowledge_check_map` carries a composite foreign key `(project_id, knowledge_id)` referencing `knowledge(project_id, id)`, not a plain `knowledge_id` reference. A plain reference only proves the id exists; the composite one stops a project's mapping from pointing at another project's claim - the tenant boundary the whole attestation model rests on. It references the `knowledge_project_id_uq` index that L0 created for exactly this.

- 2c1aa99: Complete the demotion path in the promotion ledger, and return the validation id and stored counted.

  Demotion already worked - `recordKnowledgeSignal` was written whole in L0, so a `contradict` signal already moved an entry to `contradicted` and left `promoted_at` in place, while an agent-authored `error_event` could demote but never promote. What this adds is the tests L1 requires: an error event demoting a `candidate` (not only a `trusted`), a second contradiction on an already-contradicted entry recording evidence without a second audit row, and a repeated error signature deduplicating to one - the mirror of a rerun green check counting as one support.

  The attest response contract is `{ validationId, counted }`, so both are now on the result. The subtlety is dedup: `onConflictDoNothing` returns nothing on a replay, but attestation is idempotent and a replay must return the original validation. So a no-op reads the conflicting row back inside the same lock and returns its stored `counted` - the stored value, not the caller's input, since the original write is what stands.

- f1ed68a: Add `knowledge_metric_daily`: the storage for the Learning panel's four metrics, migration `0017`.

  One row per project per UTC day, storing raw numerators and denominators rather than ratios so a metric can be recomputed and a definition change is detectable. Every metric column is nullable on purpose: a day where a metric was not computed is null, which has to stay distinct from a real zero, or the panel would render "not enough data" as 0%. `normalization_version` is the one non-null count column, so a change in how a metric is defined shows up in the series rather than silently shifting the line.

  Storage only - the rollup that fills these columns lives in server, and the window logic each metric needs (a 7-day lookback for repeat errors, a 14-day lookahead for precision) is a computation concern, not encoded in the schema. A row holds that day's raw counts and nothing about how they were derived.

- cc2f4e1: Add a request-context-free project access decision, and the knowledge promotion transaction.

  `decideProjectAccess` answers "may this member do this here" from three facts the caller already has - org role, ban timestamp, and stored grant - and returns a reason rather than a message, so the dashboard can translate it and the MCP server can map it to a status code. The rule that an org owner or admin is an effective project owner without any stored grant travels with it; that rule lived only in the web helper, and a naive level comparison would have locked those users out of projects they administer. A `project_access.level` outside the known set is treated as no grant rather than trusted, so a leftover value cannot be read as authority.

  `recordKnowledgeSignal` is the single implementation of the promotion ledger. It locks the entry, records the signal, re-counts, updates only from the expected state, and writes an audit row **only when the state actually changed** - promoting something already promoted must not add a second entry to a ledger whose purpose is to say when things changed. Promotion counts distinct issuers, so a hundred CI runs are one voice. The tenant boundary is enforced inside the function: an entry belonging to another project is answered exactly as a nonexistent one, because on a path a project's CI secret can reach, confirming that an id exists is itself a disclosure.

- d1b5dcd: Add human owner promotion, and route both permission checks through the shared rule.

  A project owner can confirm a candidate entry, which records the supporting signal, promotes it, and writes the ledger row - in one transaction, through the same function CI attestation will call later. The confirmation dialog says plainly that the action cannot be undone and is recorded, because that is what it is. Only candidates show the control, and only to an owner: the other states are not waiting on a decision.

  The dashboard and the MCP `learn` tool now both ask `decideProjectAccess` rather than each comparing levels themselves. The rewire also closes a gap it exposed: the ban check and the grant level were previously two separate reads, so a ban landing between them could let an already-revoked permission through. Both facts now come from one read.

  `@relayroom/db` gains a `./knowledge` subpath export, matching the existing `./governance` one. Importing from the package root pulls in the migration runner, whose directory URL the web bundler cannot resolve - a failure that appears only at build time, not under the type checker or the tests.

- 31b3279: Add the Project Knowledge substrate: `knowledge`, `knowledge_validation`, `knowledge_audit`, and `recall_log`, with migration `0015`.

  This is the storage layer for 0.5.0's retrieval loop - durable project facts an agent can look up before acting, and the ledger that records how each one earned trust. Nothing reads or writes these tables yet.

  The migration installs `pg_trgm` and a GIN trigram index over `title || ' ' || body`, which is what makes the `%`-operator similarity search usable rather than a sequential scan. It also creates a unique index on `(project_id, id)` now rather than later: the composite foreign key that keeps one project's CI from attesting another project's knowledge references it, and adding the index in a subsequent migration would mean two migrations where one will do.

- c791ead: Purge the knowledge derived from a thread, and say honestly what that will do.

  Knowledge is a distilled copy, so deleting a thread cascades nothing. An owner can now purge everything derived from a given thread explicitly. An entry whose only source is that thread is deleted; an entry that also came from elsewhere keeps its content and loses only that one provenance reference.

  Because those are two different outcomes, the confirmation reports both counts rather than one total. The preview runs the same code path as the delete with a dry-run flag, so the number shown and the number acted on cannot diverge.

- f37f9fa: Make `pnpm --filter @relayroom/db migrate` run, and label the two knowledge defaults nobody derived.

  The migrate script lived inline in `package.json` and contained `$client`, which the shell running it expanded to nothing - the command reaching the runtime was `db..end()`, a parse error. Server startup was unaffected because it calls the migration runner directly, so the break was invisible until someone tried to migrate by hand, which is generally when something has already gone wrong. It is now a file rather than a string in a field the shell rewrites.

  Two values in the promotion transaction now say what they are. The contradiction window is a number nobody derived, and no code path in this slice reaches it. `confidence` is left unwritten when the caller does not supply it, because the design never defined how it is computed - which means recall ranking currently reduces to trigram similarity, and that is a decision rather than an oversight.

- c791ead: Turn recurring failures into proposals a human approves, closing the loop back onto the project's own norms.

  A leased job clusters repeating error signatures, and surfaces contradicted entries the same way. Once a signature recurs across two distinct agents or three times, it drafts a proposal: the evidence, the hypothesis, the concrete change, and the condition that would show the hypothesis is wrong. Owners review the queue and approve or reject; nothing is ever applied automatically.

  Approving a knowledge proposal records a **candidate**, not a trusted fact. An owner confirming a specific entry they have read does promote it; working down a queue of automatically drafted ones is a different act, and treating it as the same would let "I reviewed these" become approval by scrolling. The difference is the density of the judgement, not the authority behind it. Approving a playbook change snapshots a new version, and rollback appends a further version carrying the earlier content rather than overwriting history.
