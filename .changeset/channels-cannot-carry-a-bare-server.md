---
"@relayroom/cli": patch
---

Wakes stop being lost silently: `--channels` can never carry a bare MCP server, so RelayRoom no longer launches with it, and channel delivery becomes opt-in.

Claude Code's channels research preview accepts only plugins from an allowlist whose entries name a marketplace and a plugin. RelayRoom registers its channel as a plain MCP server in `.mcp.json` and passed it as `server:relayroom-channel`, which that allowlist cannot express. Claude connected the server, accepted its pushes, and dropped every one of them - writing a single line into its own MCP log and nothing anywhere a user would look. The status bar stayed green on every indicator, the unread count kept rising, and no agent woke up until a human typed at it.

The readiness check is the reason it went unnoticed for as long as it did. It asked `claude mcp list` whether the server was `Connected`, which was true throughout, and is a different question from whether pushes are delivered. It now reads the outcome Claude records - `Channel notifications registered` against `Channel notifications skipped` - because that is evidence about the thing being decided.

**Channel delivery is now off unless you ask for it**, with `./rr.sh up --channel` or `relayroom channel on`. The default is the pager, which types into the pane and depends on no preview feature, no flag, and no allowlist. This is not a judgement that channels are worse: turn-boundary delivery is genuinely nicer than deferred keystrokes, and nobody has measured by how much. It is that the pager is the path we control end to end, and a wake that arrives slightly less elegantly beats a wake that never arrives.

**You will see the difference.** Under the pager, a wake appears as text typed into the session rather than as an injected event, so the console looks different from 0.6.0 even though the agent behaves the same.

Two fields now carry what one used to. `channel` records what you asked for and is written only by an explicit command; `delivery` records the mode actually running and is written by the launcher and the watcher. Falling back to the pager no longer erases the request, and a stale `delivery` can no longer be mistaken for one - the outage happened in the gap those two meanings left when a single field held both.

When channels are on, the launcher answers the development-flag confirmation and then **checks Claude's log to see whether registration actually happened**, rather than treating the dismissed prompt as success. If registration is not observed, it switches to the pager and restarts it, records why in `.relayroom/channel.state`, counts consecutive failures so one bad launch reads differently from a week of them, and says so in `rr.sh status` and on the tmux bar. Nothing depends on matching the prompt's wording: if that text changes, the prompt is missed, the log check still runs, and the result is the fallback.
