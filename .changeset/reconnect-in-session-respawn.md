---
"@relayroom/cli": patch
---

`rr.sh reconnect`: re-register and reload the session from inside it, and say so when a respawn fails.

MCP registration is read at process start, so an agent that re-registers mid-session still has no tools until the session is replaced - and the process that needs to do the replacing is the one running inside it, where the kill takes its own shell with it mid-command. `reconnect` hands that work to a detached script that outlives both, then re-registers and replaces the session with `--continue`, so the conversation survives.

It shares one primitive with `up --restart`; only the caller differs, and the caller is detected rather than declared. Detection is safe to prefer here because the two paths are not symmetric: the detached path works from either caller and the in-place path only works from outside, so a detection that cannot answer resolves to detached and costs a slower restart rather than a shell killed mid-command. The alternative - an explicit flag - would put that decision on the caller least able to make it, an agent that has just lost its board.

A detached respawn outlives whoever asked for it, so a failure would otherwise have nobody left to report it: the agent's session is gone and the owner sees only a part that went quiet. The outcome is now recorded, and `up` and `status` report a failed respawn so the silence explains itself. The wait for the calling process is bounded and records the reason when it gives up, since a silent wait and a silent failure look identical from outside.
