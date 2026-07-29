---
"@relayroom/cli": patch
---

`up` now does what its name promises: it ensures setup, refuses a session that predates its own configuration, and stops accepting flags it will not apply.

`up` never ran `setup`, so a worktree where registration had never happened got a tmux session and a pager and no MCP, silently. It now runs setup on the way past, before the launch decision, so the approval it writes is in place when channel readiness is probed.

It also short-circuited entirely when a session already existed. `.mcp.json` and `.claude/settings.json` are read at process start, so a registration written afterwards was never picked up - and `up` is the command people reach for to fix exactly that. This is the failure `doctor` structurally cannot see: every file on disk is correct and the process that needed to read them started earlier, so doctor is truthfully green about a session that will never work. `up` now compares the session's start time against those files and refuses with the evidence rather than the conclusion - "session started 09:41, .mcp.json written 10:02 - the running agent never read it" - and points at `./rr.sh up --restart`. It refuses rather than restarting silently because a restart discards whatever the agent is doing mid-turn; refusing is safe here specifically because `up` ends in attach, so the message always has a reader.

Staleness is read *before* setup runs, and a config change made by setup itself is detected by content rather than mtime, because `claude mcp add` rewrites `.mcp.json` on every run whether or not anything changed. For the same reason `installHook` now writes `.claude/settings.json` only when the merged result differs: a no-op must be silent in every channel it can speak through, and mtime is one of them.

`--bypass` and `--new` are consumed only when a session is created, so passing them to a running session applied nothing and said nothing. That is now an error naming the flag and pointing at `--restart`, which does create a session and does apply them.

Also fixes `setup` doing nothing at all on a worktree whose config names no agent: everything else defaults to claude, but `read -ra` splits an empty string into zero words, so the registration loop ran zero times, silently.

`up` also replaces a session whose panes are all dead - the state `remain-on-exit on` produces, where tmux keeps the session alive after the agent exits so `tx_exists` says yes for a corpse. It reports the exit status, since that is the evidence anyone who turned that option on is trying to collect, and it does not wait for `--restart`: a corpse has no mid-turn work to lose, which is the only reason that flag exists.
