---
"@relayroom/cli": patch
"@relayroom/shared": patch
---

`doctor` now catches the two ways a part can work correctly under the wrong identity, and the playbook tells an agent how to check the one no shell command can see.

A part wrote to the board as a sibling for three days. Every file was right - `pwd`, `.mcp.json`, `.relayroom/config.json` all named it correctly - and the live MCP connection named someone else, because registration is read once at startup and the file was fixed after the session began. `inbox` quietly showed the other part's mailbox, so "no new messages" meant *their* mailbox was empty, and `doctor` was green throughout. Working as someone else looks like working.

**A local entry naming another part is now an error.** Measured: Claude resolves LOCAL scope ahead of project scope, so a shared repo-root entry hands a session someone else's part while this worktree's files say otherwise - and `.mcp.json` need never have changed, so no timestamp moves. A leftover naming *this* part stays a warning, since it cannot misattribute anything.

**A session running config that no longer matches disk is now an error.** Compared by content, not timestamp: `claude mcp add` rewrites `.mcp.json` on every `setup` even when nothing changes, and `doctor` is what people run right after `setup`, so a timestamp check would fire in the most common sequence. A false error costs more than a missed one - it spends the credibility that made errors worth promoting. When no record exists (a session from an older CLI), the verdict is "unknown" and reported as a warning with its evidence rather than promoted.

**The playbook now tells agents to compare `whoami` against `.relayroom/config.json`.** That comparison cannot be done from a shell - the transcript holds no record of the live connection, and the reachable HTTP endpoints take the part *from* the file - so the agent is the only one who can make it. `./rr.sh reconnect` is the fix in every case.

Also records an explicit decision about where checks live: `doctor` reports every check, `up` acts on the subset that blocks a launch, and nothing goes in `up` alone. The instrument for this incident already existed and was wired only into `up`, so the command people actually run when something looks wrong could not see it.
