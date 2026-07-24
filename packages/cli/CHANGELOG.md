# @relayroom/cli

## 0.5.1

## 0.5.0

### Minor Changes

- c791ead: Project Knowledge: turn the message stream into a knowledge layer agents read before they act, and measure whether it compounds.

  Between runs, nothing accumulated. One agent worked out how migrations run in this repo and said so in a thread; the thread closed; next week another agent asked the same question, because the answer was sitting somewhere nobody re-reads. This release closes that loop on the Postgres you already own.

  Agents `recall` validated project facts before non-trivial work and `learn` durable ones they discover. Closed threads are distilled into candidate entries automatically. Recurring failures become proposed knowledge and playbook changes a human approves. Trusted facts are served back in the playbook every agent reads. The dashboard reports whether repeat errors are actually falling.

  The property that makes this safe rather than merely convenient is that **an agent can never promote its own claim**. An entry becomes trusted only when either a configurable number of distinct issuers support it, or the project's owner deliberately confirms it, and in both cases only while nothing has contradicted it. The whole of CI counts as a single issuer, so a hundred green runs cannot carry a claim across on their own: the threshold exists to stop an automated system holding a signing key from deciding truth by itself, not to overrule the person who owns the project. A contradiction demotes. Automation widens what gets captured, never what gets trusted, so a wrong fact cannot amplify as fast as a right one.

  This is a typed, provenance-tracked knowledge table, not a semantic or temporal graph. Relationship modeling is not built here and the feature is not named as though it were.

### Patch Changes

- 3e242ec: Stop a CLI test from downloading the published package to test the local one.

  `rr.sh` falls back to `npx -y @relayroom/cli` when `relayroom` is not on `PATH`, which is correct product behaviour. In the test environment it meant the `doctor` case fetched the package from the npm registry - so the test exercised whatever was published rather than the code under test, and failed in CI where nothing installs the CLI globally while passing on any machine that has it. A stub on `PATH` removes the network from a unit test.

  The test and subprocess timeouts now come from one place, with the test budget strictly larger than the child's. Equal values would race, and a vitest timeout that wins reports its own generic message instead of whatever the child actually did. A guard test asserts the relationship holds and that no test file quietly declares a child budget the config cannot outlast.

- c791ead: Serve a project's most-trusted facts in the playbook, and let a worktree tell whether it is on the current norms.

  The served playbook can carry a short generated block of top trusted facts, kept visually separate from the human-authored body and marked as generated. It stays hidden until a project has accumulated a few trusted entries, so a new project sees no clutter, and it is identical across worktrees.

  The playbook now also has a content hash, reported by `rr.sh update` and exposed as a response header. The hash deliberately covers the authored body and the facts block but not the "current main agent" line: that line is operational state, and a handoff is not a change in norms.

  The default playbook and the provider instruction files gain a short note on when to `recall`, when to `learn`, and that a recalled fact which is not yet trusted is a lead to verify rather than an answer.

- c791ead: Report token usage for turns that end in a tool call, which was most of them.

  The transcript parser walked backwards and stopped at the first user-role row, treating it as the start of the turn. Tool results are recorded as user-role rows, so any turn that used tools ended on one: the parser stopped immediately, summed nothing, and the reporter skipped the upload as an empty turn. For agents doing real work, which is to say agents that call tools, the dashboard stayed empty.

  A tool result is now recognised as mid-turn and skipped, and only a genuine prompt ends the walk. As a side effect the totals are also correct for the first time, since usage is summed across the whole turn rather than the fragment after the last tool call.
