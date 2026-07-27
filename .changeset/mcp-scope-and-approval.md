---
"@relayroom/cli": patch
---

Stop one worktree's `setup` from silently disconnecting the others, and approve the servers it registers.

`mcp_add` ran `claude mcp remove relayroom -s local` unconditionally. Claude keys local scope to the git **repo root**, not the worktree, so that one line is a fleet-wide delete: every sibling worktree still reading the shared entry lost the board with no message, no log, and nothing changed in its own directory. It also announced itself on every run, no-op or not - so the session that read "Removed MCP server relayroom from local config" was never the session that lost anything, while the one that did lose a registration was told nothing.

`setup` now registers this worktree in project scope first, verifies the entry actually landed, and retires the shared local entry only when it names this same part. A local entry belonging to another part is left alone and reported; a run with nothing to remove says nothing at all. After registering, `setup` lists any sibling worktrees that have no registration of their own - it cannot write their files, since each needs the token from its own `.relayroom/config.json`, but the worktree whose setup would break them is the one that should say so. The enumeration is `git worktree list` because the blast radius is exactly one repo root.

`setup` also writes `enabledMcpjsonServers` into the worktree's `.claude/settings.json`, the file it already owns. Claude checks `.mcp.json` approval at startup, so a registered-but-unapproved worktree keeps working until its next relaunch and then comes back with no board **and** no wake channel - unable to report the condition, because reporting it needs the channel. The two RelayRoom servers are approved by name rather than with `enableAllProjectMcpServers`, so nothing else that lands in `.mcp.json` later is trusted, and existing approvals are merged rather than replaced.

`doctor` gains both states: it reports a repo-root local entry even when this worktree is healthy, since that is the one that breaks siblings later, and it treats registered-but-unapproved as an **error** rather than a warning - an all-ok report on a part that will not come back is the check that stops anyone looking. Its advice for a missing registration is now `./rr.sh setup`; it used to print the fleet-wide delete as the fix.
