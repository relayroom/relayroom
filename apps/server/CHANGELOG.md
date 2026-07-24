# @relayroom/server

## 0.5.1

### Patch Changes

- 5d49351: Correct the field count in the attestation canonical-encoding comment.

  The header described "the SEVEN fields" while `AttestClaim` and `CANONICAL_FIELDS` both list eight, and the related note about an extra field was off by the same one. Signing behaviour is unaffected - only the prose was wrong. It is worth fixing because this file declares itself the single source of truth for the bytes both sides sign, so a reader counting along with the comment would find it disagreeing with the list directly beneath it.

  Found by the agent writing the public documentation, while checking each stated number against the code rather than against the brief.

  - @relayroom/db@0.5.1
  - @relayroom/shared@0.5.1
  - @relayroom/telemetry@0.5.1

## 0.5.0

### Minor Changes

- c791ead: Project Knowledge: turn the message stream into a knowledge layer agents read before they act, and measure whether it compounds.

  Between runs, nothing accumulated. One agent worked out how migrations run in this repo and said so in a thread; the thread closed; next week another agent asked the same question, because the answer was sitting somewhere nobody re-reads. This release closes that loop on the Postgres you already own.

  Agents `recall` validated project facts before non-trivial work and `learn` durable ones they discover. Closed threads are distilled into candidate entries automatically. Recurring failures become proposed knowledge and playbook changes a human approves. Trusted facts are served back in the playbook every agent reads. The dashboard reports whether repeat errors are actually falling.

  The property that makes this safe rather than merely convenient is that **an agent can never promote its own claim**. An entry becomes trusted only when either a configurable number of distinct issuers support it, or the project's owner deliberately confirms it, and in both cases only while nothing has contradicted it. The whole of CI counts as a single issuer, so a hundred green runs cannot carry a claim across on their own: the threshold exists to stop an automated system holding a signing key from deciding truth by itself, not to overrule the person who owns the project. A contradiction demotes. Automation widens what gets captured, never what gets trusted, so a wrong fact cannot amplify as fast as a right one.

  This is a typed, provenance-tracked knowledge table, not a semantic or temporal graph. Relationship modeling is not built here and the feature is not named as though it were.

### Patch Changes

- c791ead: Serve a project's most-trusted facts in the playbook, and let a worktree tell whether it is on the current norms.

  The served playbook can carry a short generated block of top trusted facts, kept visually separate from the human-authored body and marked as generated. It stays hidden until a project has accumulated a few trusted entries, so a new project sees no clutter, and it is identical across worktrees.

  The playbook now also has a content hash, reported by `rr.sh update` and exposed as a response header. The hash deliberately covers the authored body and the facts block but not the "current main agent" line: that line is operational state, and a handoff is not a change in norms.

  The default playbook and the provider instruction files gain a short note on when to `recall`, when to `learn`, and that a recalled fact which is not yet trusted is a lead to verify rather than an answer.

- 54aae39: Add the CI attestation endpoint and the agent demotion path.

  `POST /api/knowledge/attest` is the non-agent channel that can promote knowledge to trusted. It is a plain HTTP route, not an MCP tool, so an agent holding a connect code cannot reach it. It verifies an HMAC over a canonical body, selects the signing key by `keyId` (current or previous within its grace window), bounds clock skew, checks that the claim belongs to the signing project, and spends a per-project nonce - in that order, so a forged request is rejected before it can burn a nonce it never earned. Promotion itself is left to the shared ledger function, which counts the entire CI system as one issuer.

  Agents get the safe direction only. An `error` event carrying `detail.contradicts` records a contradiction against the named entry, demoting it; no event payload can promote, because the signal is fixed to `contradict`. A contradiction that cannot be applied (unknown entry, or another project's) is reported in the response rather than swallowed, and the path is rate-limited so a demotion loop cannot quietly retire an entry.

- c791ead: Distill closed threads into candidate knowledge, with redaction applied before anything is written.

  A thread reaching `closed` or `answered` sets a durable marker; a leased sweep claims dirty projects under an advisory lock so exactly one worker extracts a project at a time. Correctness rests on the marker plus an idempotent sweep rather than on a notification, so a missed signal is a non-event: the next sweep still catches it.

  The per-project redaction denylist runs before any write, and a matched span is dropped rather than masked, so a secret never reaches storage in any form. It covers manual `learn` as well as the extractor, since a human typing a secret into `learn` is otherwise an unredacted path into the same table.

  Extractor output is always `candidate`. Automation widens intake, not trust.

- a219c1f: Add the `recall`, `learn`, and `recall_used` MCP tools.

  `recall` is the retrieval-before-action surface: an agent asks what the project already knows before starting work. It returns only entries that have earned `trusted`, ranked by trigram similarity against the entry text weighted by confidence, and it logs what it returned so recall-hit-rate is measurable rather than assumed.

  `learn` is the capture side, and it always writes `candidate` - never `trusted`, by any path. Nothing an agent says about the world becomes something other agents are told until a separate promotion step says so. `recall_used` closes the measurement loop by recording which returned entry was actually acted on.

  Expired entries are filtered out of `recall` even before the retention sweep removes them: an `expiresAt` in the past is somebody's decision that the entry should stop being repeated, and honoring it only at sweep time would keep repeating it in the meantime. `recall_used` accepts only an entry that the given query actually returned, so the hit-rate metric cannot be inflated by an agent naming an arbitrary id.

- e8ebe80: Add the daily knowledge-metrics rollup that fills the Learning panel.

  For each project and UTC day it computes the four metrics as raw numerators and denominators - repeat-error rate (a 7-day signature lookback), recall-hit rate, precision (a 14-day contradiction lookahead), and candidate-to-trusted p50 - plus a snapshot of the current trusted and candidate totals. Every metric is agent-sourced telemetry, which the module states at the top: the rollup claims direction, not ground truth.

  Precision is the subtle one. A contradiction is a late, negative signal, so a freshly promoted entry looks better than it is until its 14-day window closes. The rollup therefore recomputes a trailing 14 days on every run and backfills, and a comment says why so the recomputation is not later "optimized" away into an optimistic bias. The trusted/candidate counts are the opposite: a point-in-time snapshot, deliberately excluded from that recomputation window - the SET on a revisit touches only precision, so a past day's stock stays the past's, and a test pins that a later run does not re-snapshot it.

  The error-signature definition lives in a shared module with an explicit version constant, so the L4 clusterer reuses the same definition rather than growing a second copy.

- d1b5dcd: Add human owner promotion, and route both permission checks through the shared rule.

  A project owner can confirm a candidate entry, which records the supporting signal, promotes it, and writes the ledger row - in one transaction, through the same function CI attestation will call later. The confirmation dialog says plainly that the action cannot be undone and is recorded, because that is what it is. Only candidates show the control, and only to an owner: the other states are not waiting on a decision.

  The dashboard and the MCP `learn` tool now both ask `decideProjectAccess` rather than each comparing levels themselves. The rewire also closes a gap it exposed: the ban check and the grant level were previously two separate reads, so a ban landing between them could let an already-revoked permission through. Both facts now come from one read.

  `@relayroom/db` gains a `./knowledge` subpath export, matching the existing `./governance` one. Importing from the package root pulls in the migration runner, whose directory URL the web bundler cannot resolve - a failure that appears only at build time, not under the type checker or the tests.

- fdb3fa2: Retire knowledge entries once they pass their expiry.

  An `expiresAt` is somebody's decision that an entry should stop being repeated, so a sweep moves expired entries to `retired` and writes an audit row for each transition. `recall` already excludes them directly, so the sweep is what makes the state on disk match what agents are being told rather than what closes the gap.

  Scope is deliberately the expiry sweep alone. Garbage-collecting old candidates needs a retention policy that has no default until a later slice, so implementing it now would ship a sweep that can never act.

- 1725cf6: Pin the MCP tool contract with a snapshot test.

  `tools/list` is what every connected agent reads to decide what it can call and how, so a change there changes behaviour for every agent at once - and nothing was pinning it. Renaming an argument, dropping an enum value from a description, or quietly loosening a schema all shipped without anyone having to look.

  The snapshot is taken from the normalized reply, after the draft-07 keywords strict clients reject have been stripped, because that is the shape clients actually receive. Tool names are a separate inline snapshot: adding or removing a tool is a much bigger change than editing a description, and separating them makes it visible in a diff without reading three hundred lines of schema. A third test asserts the property directly rather than trusting the snapshot to be read carefully - no banned keyword appears in any advertised schema, since a tool registered without normalization would break Gemini-family clients for everyone.

- c791ead: Turn recurring failures into proposals a human approves, closing the loop back onto the project's own norms.

  A leased job clusters repeating error signatures, and surfaces contradicted entries the same way. Once a signature recurs across two distinct agents or three times, it drafts a proposal: the evidence, the hypothesis, the concrete change, and the condition that would show the hypothesis is wrong. Owners review the queue and approve or reject; nothing is ever applied automatically.

  Approving a knowledge proposal records a **candidate**, not a trusted fact. An owner confirming a specific entry they have read does promote it; working down a queue of automatically drafted ones is a different act, and treating it as the same would let "I reviewed these" become approval by scrolling. The difference is the density of the judgement, not the authority behind it. Approving a playbook change snapshots a new version, and rollback appends a further version carrying the earlier content rather than overwriting history.

- Updated dependencies [c791ead]
- Updated dependencies [5b6705f]
- Updated dependencies [2f5f75d]
- Updated dependencies [2c1aa99]
- Updated dependencies [f1ed68a]
- Updated dependencies [cc2f4e1]
- Updated dependencies [d1b5dcd]
- Updated dependencies [31b3279]
- Updated dependencies [c791ead]
- Updated dependencies [c791ead]
- Updated dependencies [f37f9fa]
- Updated dependencies [c791ead]
  - @relayroom/shared@0.5.0
  - @relayroom/db@0.5.0
  - @relayroom/telemetry@0.5.0
