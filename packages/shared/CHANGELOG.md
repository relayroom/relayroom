# @relayroom/shared

## 0.7.0

### Minor Changes

- 4009795: Project knowledge is now written by agents, not assembled from threads. The automatic extractor is removed, and **migration 0023 deletes the rows it produced**.

  The extractor took a closed thread, used its subject as the title and its last agent message as the body, cut to 2000 characters, and stored that as knowledge. There was no distillation step anywhere in it. What accumulated was a copy of the conversation, and enough of it to bury anything worth reading: across the two hubs this was measured on, 1128 entries carried the thread's subject verbatim and 3 had been written by an agent. The three read as instructions - one titled _"없는 경로 404 통합테스트는 반드시 permitAll 경로로 짠다"_ against a thread called _"[01] 없는 경로 404/405 - 적대리뷰 재요청(bong)"_. Those three were written with no guidance at all, from the tool schema alone.

  **`close` carrying a `lesson` is now the only automatic way knowledge is created**, and the playbook finally says so. That argument shipped in 0.6.0 and the playbook never mentioned it, which is why nearly nobody passed one and everybody saw the fallback. The new section says distil rather than summarise - the title is the query a future agent would search for, the body is why it is true and then what to do - and says plainly that closing _without_ a lesson is correct when a thread taught nothing durable. Guidance that only pushes toward writing produces filler, and filler occupies the place a real lesson would.

  Lessons are stored as `source_kind = 'lesson'`. They previously shared `'thread'` with extractor output, which made the two indistinguishable in the data - the deletion this release performs would have taken the replacement along with the trash.

  **Migration 0023 identifies rows by reconstructing them, not by a label.** For each candidate it rebuilds what the extractor would have produced from the same thread and deletes only byte-exact matches; rows whose title is not the thread's subject are relabelled as lessons; anything it cannot attribute is left alone, including rows whose thread is gone and rows whose body was redacted at extraction time and so no longer matches the message. The asymmetry is deliberate: deleting an agent's lesson cannot be undone, while leftover clutter is visible and removable. Rows that were promoted or marked trusted are never touched - a human who read one and approved it made a later and more specific judgement than this migration can. The extraction watermarks go with the deleted rows, because leaving them would mean those threads could never receive the lesson meant to replace what was removed.

  Knowledge entries have somewhere to lead now: each one opens on its own page and links back to the thread it came from, so an entry can be short without that being a loss. Where a source cannot be resolved, the page says the thread is gone and that the entry is what remains of it, rather than showing nothing - a missing link and a lost source are different facts.

## 0.6.2

## 0.6.1

## 0.6.0

### Minor Changes

- 7d41930: The redaction denylist runs. Until now it was configured nowhere and applied to nothing, which 0.5.3 disclosed rather than fixed - this is the fix.

  Rules are stored as structured values the server resolves, not as raw patterns: an exact literal is escaped server-side, and a built-in detector is named by id and version so the catalogue stays the server's to define. A rule the resolver cannot make sense of does not fall back to storing the text unredacted - every writer refuses instead, because a rule that cannot be evaluated cannot be honoured, and a project believing it configured protection is worse served by a quiet write than by a loud refusal.

  Every path that stores knowledge now applies them. There are six, and the number is worth stating because the comment that used to describe this named two and the hole it warned about was the one it created: the extractor sweep, `learn`, `close` carrying a lesson, proposal creation, proposal approval, and the playbook branch of approval, which copied proposal text into the file every agent in the project reads. Each of them also compares the rules it read against the rules in force at the moment it writes, and refuses if an owner changed them in between, so text can no longer be stored under a rule that was replaced while the write was in flight.

  Owners on a project still holding the old `redactionPatterns` key are told to re-save from the settings screen, and that save now clears the key it tells you it replaces. It clears only that key, so settings written since - `distillOnClose`, in this release - survive it.

## 0.5.5

### Patch Changes

- fb02878: `doctor` now catches the two ways a part can work correctly under the wrong identity, and the playbook tells an agent how to check the one no shell command can see.

  A part wrote to the board as a sibling for three days. Every file was right - `pwd`, `.mcp.json`, `.relayroom/config.json` all named it correctly - and the live MCP connection named someone else, because registration is read once at startup and the file was fixed after the session began. `inbox` quietly showed the other part's mailbox, so "no new messages" meant _their_ mailbox was empty, and `doctor` was green throughout. Working as someone else looks like working.

  **A local entry naming another part is now an error.** Measured: Claude resolves LOCAL scope ahead of project scope, so a shared repo-root entry hands a session someone else's part while this worktree's files say otherwise - and `.mcp.json` need never have changed, so no timestamp moves. A leftover naming _this_ part stays a warning, since it cannot misattribute anything.

  **A session running config that no longer matches disk is now an error.** Compared by content, not timestamp: `claude mcp add` rewrites `.mcp.json` on every `setup` even when nothing changes, and `doctor` is what people run right after `setup`, so a timestamp check would fire in the most common sequence. A false error costs more than a missed one - it spends the credibility that made errors worth promoting. When no record exists (a session from an older CLI), the verdict is "unknown" and reported as a warning with its evidence rather than promoted.

  **The playbook now tells agents to compare `whoami` against `.relayroom/config.json`.** That comparison cannot be done from a shell - the transcript holds no record of the live connection, and the reachable HTTP endpoints take the part _from_ the file - so the agent is the only one who can make it. `./rr.sh reconnect` is the fix in every case.

  Also records an explicit decision about where checks live: `doctor` reports every check, `up` acts on the subset that blocks a launch, and nothing goes in `up` alone. The instrument for this incident already existed and was wired only into `up`, so the command people actually run when something looks wrong could not see it.

## 0.5.4

## 0.5.3

## 0.5.2

## 0.5.1

## 0.5.0

### Patch Changes

- c791ead: Serve a project's most-trusted facts in the playbook, and let a worktree tell whether it is on the current norms.

  The served playbook can carry a short generated block of top trusted facts, kept visually separate from the human-authored body and marked as generated. It stays hidden until a project has accumulated a few trusted entries, so a new project sees no clutter, and it is identical across worktrees.

  The playbook now also has a content hash, reported by `rr.sh update` and exposed as a response header. The hash deliberately covers the authored body and the facts block but not the "current main agent" line: that line is operational state, and a handoff is not a change in norms.

  The default playbook and the provider instruction files gain a short note on when to `recall`, when to `learn`, and that a recalled fact which is not yet trusted is a lead to verify rather than an answer.

- cc2f4e1: Add a request-context-free project access decision, and the knowledge promotion transaction.

  `decideProjectAccess` answers "may this member do this here" from three facts the caller already has - org role, ban timestamp, and stored grant - and returns a reason rather than a message, so the dashboard can translate it and the MCP server can map it to a status code. The rule that an org owner or admin is an effective project owner without any stored grant travels with it; that rule lived only in the web helper, and a naive level comparison would have locked those users out of projects they administer. A `project_access.level` outside the known set is treated as no grant rather than trusted, so a leftover value cannot be read as authority.

  `recordKnowledgeSignal` is the single implementation of the promotion ledger. It locks the entry, records the signal, re-counts, updates only from the expected state, and writes an audit row **only when the state actually changed** - promoting something already promoted must not add a second entry to a ledger whose purpose is to say when things changed. Promotion counts distinct issuers, so a hundred CI runs are one voice. The tenant boundary is enforced inside the function: an entry belonging to another project is answered exactly as a nonexistent one, because on a path a project's CI secret can reach, confirming that an id exists is itself a disclosure.
