# @relayroom/web

## 0.5.1

### Patch Changes

- c6282a7: Fix the dashboard failing to load for any organization with more than one project.

  The agent-status lookup built its own `ANY(ARRAY[...]::text[])` filter against `agent.project_id`, which is a uuid column, so Postgres rejected the query with "operator does not exist: uuid = text". `getDashboardSummary` caught it and reported a failure, which took the projects, agents and organizations widgets down together.

  It only appeared with two or more projects: the code branched on `projectIds.length === 1` and the single-project branch used a plain equality that worked fine, so the broken side went unnoticed until an organization had a second project. The filter is now `inArray`, which casts to the column's own type and removes the one/many split entirely - the split was the reason half the code path was never exercised. The same needless split has been collapsed in the organization queries. Regression tests now cover two and three projects, not just one.

- 8e66858: Widen the knowledge Proposals and CI attestation pages to match every other page.

  Both were laid out at `max-w-3xl` while the knowledge tab they sit under, the other project tabs, and the dashboard all use `max-w-6xl`, so moving between tabs made the content jump narrower for no reason. They now use the same width as their siblings.

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

- c791ead: Default the agent connect instructions to bypass mode.

  These sessions are unattended by design. An agent that stops at an approval prompt waits for someone who is not watching, which is a worse outcome in this setting than the checks the flag skips. The label still says plainly that it skips all permission checks, and the hint now describes what turning it off costs, since that is the decision a reader actually faces once it is on by default.

- bcd4d4d: Mark the attestation rotation grace window as a chosen value, not a specified one.

  The design says `attest_secret_prev_expires_at = now() + grace` without giving a number; the 24h in `ROTATION_GRACE_MS` is a judgement. The comment now says so, so a later reader does not treat it as derived - the same reason the L0 contradiction window carries its note. It also points at the open review item: rotation is single-mode and has no immediate-revocation path for a leaked secret.

- c791ead: Let a leaked attestation secret be revoked immediately, instead of outliving its own replacement by a day.

  Rotation kept the previous secret valid for a grace window so a CI run in flight would not break. That is right for routine rotation and wrong for the other reason a secret gets rotated: it leaked. There the window is not a courtesy, it is the exposure, and a compromised secret could keep promoting knowledge for another day. Every other credential in the system could already be cut immediately; the one guarding the CI promotion channel could not.

  Rotation now has two modes, and revoking clears the previous secret in the same write that mints the new one. The audit entry records which mode was used, so the ledger distinguishes routine hygiene from an incident instead of leaving it to inference.

  The interface states the limit plainly: revoking stops future misuse and does not undo promotions the leaked secret already made. Assuming otherwise is the dangerous reading.

- c791ead: Show a failed dashboard summary as a failure rather than as loading forever.

  The dashboard renders on the server, so by the time it renders its data is final and there is no loading state left to be in. Rendering a skeleton when the data was missing therefore did not mean "still loading", it meant "the query failed", and it animated indefinitely because nothing would ever render again. The error the query had already produced was discarded on the way.

  Failures now surface the message with a way to retry, and skeletons are left to the route's loading state where the framework actually shows them. The project count no longer falls back to zero either: a count of zero is not an empty-looking placeholder, it is a specific and false claim about the account.

- c791ead: Stop rendering failed reads as empty states.

  A read that fails and a read that legitimately returns nothing are different facts, and several pages were collapsing them. An empty state is not a neutral placeholder: it is a claim about the account, and when the query behind it had died, the claim was false.

  The inbox was the clearest case. Its attention section was guarded by a different query's result, so a failure in the attention query rendered "all caught up" - announcing an empty queue it had not managed to read. The project overview greeted a running project with the first-run "connect your first agent" banner, and the members page claimed both that there were no members and that everyone had already been added.

  Failures now say so and offer a retry, and every empty state sits inside its own query's success branch, so the failure path can no longer reach a sentence that would be untrue. Elements that merely disappear on failure are left as they are: disappearing makes no claim, while an empty state makes a false one.

- 0474fd0: Add CI attestation management: secret rotation and the check-to-claim map, owner-only.

  An owner mints an attestation secret, rotates it, and maps which CI check may attest which knowledge entry - all under `/knowledge/settings`, because turning CI into a promotion channel is part of the knowledge trust model, not general project config. The plaintext secret appears only in the mint response and has no re-read path: `getAttestStatus` returns the key id and grace state, never the secret, and a test asserts the plaintext never appears in any read. Rotation is two-slot per the design, so a running CI keeps working through the grace window, and it writes an audit row.

  The disabled state is framed as a valid policy, not a missing setup: with no secret, only a human owner promotes - which is exactly how L0 shipped. The copy also states that CI alone cannot reach the promotion threshold, so an owner who enables a secret does not expect automatic promotion and file it as a bug. The check-map only offers claims from the same project, and the composite foreign key backs that up; a test pins the clean rejection rather than letting the constraint silently stand in for the application check.

- 61d5a37: Add the project Knowledge tab.

  The four claim states with counts, filtering, pagination, and per-entry kind, title, body, provenance, and timestamps. Each row also shows how many independent issuers support it: a state label alone says "trust this" without saying why, and the point of the substrate is that a claim earns trust because something independent confirmed it. A candidate sitting at zero should read as "nothing has confirmed this yet" rather than as an unexplained label.

  That count is computed the same way the promotion transaction computes it, because the number on screen has to be the number promotion acts on - a count that merely looks plausible invites someone to promote on evidence that is not the evidence.

- d1b5dcd: Add human owner promotion, and route both permission checks through the shared rule.

  A project owner can confirm a candidate entry, which records the supporting signal, promotes it, and writes the ledger row - in one transaction, through the same function CI attestation will call later. The confirmation dialog says plainly that the action cannot be undone and is recorded, because that is what it is. Only candidates show the control, and only to an owner: the other states are not waiting on a decision.

  The dashboard and the MCP `learn` tool now both ask `decideProjectAccess` rather than each comparing levels themselves. The rewire also closes a gap it exposed: the ban check and the grant level were previously two separate reads, so a ban landing between them could let an already-revoked permission through. Both facts now come from one read.

  `@relayroom/db` gains a `./knowledge` subpath export, matching the existing `./governance` one. Importing from the package root pulls in the migration runner, whose directory URL the web bundler cannot resolve - a failure that appears only at build time, not under the type checker or the tests.

- c791ead: Purge the knowledge derived from a thread, and say honestly what that will do.

  Knowledge is a distilled copy, so deleting a thread cascades nothing. An owner can now purge everything derived from a given thread explicitly. An entry whose only source is that thread is deleted; an entry that also came from elsewhere keeps its content and loses only that one provenance reference.

  Because those are two different outcomes, the confirmation reports both counts rather than one total. The preview runs the same code path as the delete with a dry-run flag, so the number shown and the number acted on cannot diverge.

- 9f9b430: Add the Learning panel: the four compounding metrics, honestly gated.

  The panel sits above the knowledge list and shows repeat-error rate, recall-hit rate, knowledge precision, and candidate-to-trusted p50 - each as a headline over a 30-day window with a daily sparkline beneath it. Below the sample threshold it renders "not enough data" rather than a percentage, because a ratio from a handful of points is the dishonesty this whole slice exists to prevent; a gate that only hides is as useless as no gate, so a matching test asserts the number does appear once the threshold is met. Every metric is labelled agent-reported, there is no cross-customer comparison anywhere, and the normalization version is shown so a definition change is visible in the series.

  The gating and aggregation logic is a pure function with the thresholds and window as constants in one place, unit-tested directly since it is the honest core of the feature. Precision gets special handling: a contradiction is a late signal, so the most recent 14 days are still accumulating and would read optimistically. The sparkline marks that tail provisional and the headline is computed from the settled days only - verified by mutation, since a rollup that stores honest data can still be drawn as if it were final.

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
