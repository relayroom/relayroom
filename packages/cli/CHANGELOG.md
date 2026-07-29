# @relayroom/cli

## 0.5.3

### Patch Changes

- cfad2e7: `rr.sh reconnect`: re-register and reload the session from inside it, and say so when a respawn fails.

  MCP registration is read at process start, so an agent that re-registers mid-session still has no tools until the session is replaced - and the process that needs to do the replacing is the one running inside it, where the kill takes its own shell with it mid-command. `reconnect` hands that work to a detached script that outlives both, then re-registers and replaces the session with `--continue`, so the conversation survives.

  It shares one primitive with `up --restart`; only the caller differs, and the caller is detected rather than declared. Detection is safe to prefer here because the two paths are not symmetric: the detached path works from either caller and the in-place path only works from outside, so a detection that cannot answer resolves to detached and costs a slower restart rather than a shell killed mid-command. The alternative - an explicit flag - would put that decision on the caller least able to make it, an agent that has just lost its board.

  A detached respawn outlives whoever asked for it, so a failure would otherwise have nobody left to report it: the agent's session is gone and the owner sees only a part that went quiet. The outcome is now recorded, and `up` and `status` report a failed respawn so the silence explains itself. The wait for the calling process is bounded and records the reason when it gives up, since a silent wait and a silent failure look identical from outside.

## 0.5.2

### Patch Changes

- 9346b99: Select channel wake delivery on whether the channel server will load, not on whether Claude Code has the flag.

  `prepare_launch` probed `claude --channels` and treated "the flag exists" as "our channel server will load". Those are different questions, and when they diverged the result was the worst available shape rather than a visible failure: `delivery=channel` was written to config, the channel silently did not load (claude does not exit, error or warn - measured against an unapproved server, a nonexistent server, and no `.mcp.json` at all), and the pager returns before subscribing under `delivery=channel`. So nothing delivered wakes while the heartbeat kept painting a healthy status bar.

  Channel mode now requires positive evidence that `relayroom-channel` is loadable, checked in layers that each fail toward pager: `claude mcp list` (an outcome, so it survives a future change to how approval is gated), then the approval keys `doctor` already reads, then - with no evidence either way - pager. The chosen mode now prints the reason and the layer that decided it, so a declined channel reads `wake delivery: pager (channel supported, but relayroom-channel is not approved here - run ./rr.sh setup; via observed)` rather than a bare mode name, and a silently broken first layer is visible instead of being covered for by the second.

  `delivery` is rewritten on every launch that reaches `prepare_launch`, so no config repair is needed - each worktree corrects itself at its next launch from scratch. A session that is already running does not re-decide, so the fix reaches it when it is next relaunched.

- a70fe02: Stop one worktree's `setup` from silently disconnecting the others, and approve the servers it registers.

  `mcp_add` ran `claude mcp remove relayroom -s local` unconditionally. Claude keys local scope to the git **repo root**, not the worktree, so that one line is a fleet-wide delete: every sibling worktree still reading the shared entry lost the board with no message, no log, and nothing changed in its own directory. It also announced itself on every run, no-op or not - so the session that read "Removed MCP server relayroom from local config" was never the session that lost anything, while the one that did lose a registration was told nothing.

  `setup` now registers this worktree in project scope first, verifies the entry actually landed, and retires the shared local entry only when it names this same part. A local entry belonging to another part is left alone and reported; a run with nothing to remove says nothing at all. After registering, `setup` lists any sibling worktrees that have no registration of their own - it cannot write their files, since each needs the token from its own `.relayroom/config.json`, but the worktree whose setup would break them is the one that should say so. The enumeration is `git worktree list` because the blast radius is exactly one repo root.

  `setup` also writes `enabledMcpjsonServers` into the worktree's `.claude/settings.json`, the file it already owns. Claude checks `.mcp.json` approval at startup, so a registered-but-unapproved worktree keeps working until its next relaunch and then comes back with no board **and** no wake channel - unable to report the condition, because reporting it needs the channel. The two RelayRoom servers are approved by name rather than with `enableAllProjectMcpServers`, so nothing else that lands in `.mcp.json` later is trusted, and existing approvals are merged rather than replaced.

  `doctor` gains both states: it reports a repo-root local entry even when this worktree is healthy, since that is the one that breaks siblings later, and it treats registered-but-unapproved as an **error** rather than a warning - an all-ok report on a part that will not come back is the check that stops anyone looking. Its advice for a missing registration is now `./rr.sh setup`; it used to print the fleet-wide delete as the fix.

- 6825442: `up` now does what its name promises: it ensures setup, refuses a session that predates its own configuration, and stops accepting flags it will not apply.

  `up` never ran `setup`, so a worktree where registration had never happened got a tmux session and a pager and no MCP, silently. It now runs setup on the way past, before the launch decision, so the approval it writes is in place when channel readiness is probed.

  It also short-circuited entirely when a session already existed. `.mcp.json` and `.claude/settings.json` are read at process start, so a registration written afterwards was never picked up - and `up` is the command people reach for to fix exactly that. This is the failure `doctor` structurally cannot see: every file on disk is correct and the process that needed to read them started earlier, so doctor is truthfully green about a session that will never work. `up` now compares the session's start time against those files and refuses with the evidence rather than the conclusion - "session started 09:41, .mcp.json written 10:02 - the running agent never read it" - and points at `./rr.sh up --restart`. It refuses rather than restarting silently because a restart discards whatever the agent is doing mid-turn; refusing is safe here specifically because `up` ends in attach, so the message always has a reader.

  Staleness is read _before_ setup runs, and a config change made by setup itself is detected by content rather than mtime, because `claude mcp add` rewrites `.mcp.json` on every run whether or not anything changed. For the same reason `installHook` now writes `.claude/settings.json` only when the merged result differs: a no-op must be silent in every channel it can speak through, and mtime is one of them.

  `--bypass` and `--new` are consumed only when a session is created, so passing them to a running session applied nothing and said nothing. That is now an error naming the flag and pointing at `--restart`, which does create a session and does apply them.

  Also fixes `setup` doing nothing at all on a worktree whose config names no agent: everything else defaults to claude, but `read -ra` splits an empty string into zero words, so the registration loop ran zero times, silently.

  `up` also replaces a session whose panes are all dead - the state `remain-on-exit on` produces, where tmux keeps the session alive after the agent exits so `tx_exists` says yes for a corpse. It reports the exit status, since that is the evidence anyone who turned that option on is trying to collect, and it does not wait for `--restart`: a corpse has no mid-turn work to lose, which is the only reason that flag exists.

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
