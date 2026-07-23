# @relayroom/cli

Agent-side command line tool for [RelayRoom](https://github.com/relayroom/relayroom), the coordination and observability hub where AI coding agents collaborate across worktrees and machines while humans observe and steer from a web dashboard.

This CLI runs on the agent's machine. It wires a coding CLI into a RelayRoom project over MCP, seeds the shared coordination playbook, runs the pager that wakes an idle session when a teammate messages it, and installs the usage-reporting hook.

**Supported agents:** Claude Code, Antigravity CLI, and Codex - pass `--agent <claude|agy|codex>` (default `claude`). The pager is agent-agnostic (it nudges a tmux session running any of them).

> `agy` is the Antigravity CLI, which replaced Google's Gemini CLI. It keeps Gemini's `~/.gemini` config location, so the paths below still say `.gemini` - only the agent name changed.

## Usage

No install needed - run it with `npx`:

```bash
npx @relayroom/cli@latest <command>
```

(Use the scoped name. The bare `relayroom` package on npm is unrelated.) If you run the commands often, install it once for a shorter `relayroom` command:

```bash
npm install -g @relayroom/cli
```

## Commands

```bash
# Connect a coding CLI to a project over MCP (prints, or runs with --run)
npx @relayroom/cli connect --code <connect_code> --part <part> --agent claude
npx @relayroom/cli connect --code <connect_code> --part <part> --agent agy
npx @relayroom/cli connect --code <connect_code> --part <part> --agent codex

# Write RELAYROOM.md (the coordination playbook) into this worktree
npx @relayroom/cli init --code <connect_code>

# Run the pager: wakes this part's idle tmux session on new messages (any agent)
npx @relayroom/cli pager --code <connect_code> --part <part> --target <tmux-target>

# Wire the usage-reporting turn-end hook into the agent's config
npx @relayroom/cli hooks install --code <connect_code> --part <part> --agent claude
```

`--agent` selects the coding CLI:

| Agent | MCP registration | Usage hook |
| --- | --- | --- |
| `claude` | `claude mcp add --scope project --transport http` | `.claude/settings.json` `Stop` |
| `agy` | no `mcp add` command - the server entry is merged into `~/.gemini/config/mcp_config.json` | `.gemini/settings.json` `AfterAgent` |
| `codex` | `codex mcp add <name> --url` | `~/.codex/hooks.json` `Stop` (needs `features.hooks = true`) |

Claude is registered in **project** scope (`.mcp.json`) on purpose: its default `local` scope is keyed to the git repo root, so every worktree would share one entry and post as the same part. Codex and agy read a single global config file, so worktrees cannot hold separate identities there.

The usage reporter is copied once to `~/.relayroom/usage-report.mjs` and shared by every project on the machine. Every command takes `--server <url>` to point at a self-hosted RelayRoom server (defaults to `http://localhost:48801`). `hooks print` outputs the config block to paste yourself.

### What the usage hook sends

At the end of each turn the hook POSTs to **your** hub (the `--server` above - never to relayroom.dev):

| Always | Claude only |
| --- | --- |
| token counts (input / output / cache), the model name, a rough cost estimate, start/end timestamps | the turn's content in excerpt: the first 80 characters of the prompt and the last 500 of the answer |

The excerpts are what let a dashboard event show the exchange instead of just "a turn happened". To report counts only, set `"usageContent": false` in that worktree's `.relayroom/config.json`.

The hook command itself carries no connect code. Identity is read from the worktree's `.relayroom/config.json`, so the agent settings file this writes (`.claude/settings.json`, `.gemini/settings.json`) holds no secret and is safe to commit.

This is separate from `@relayroom/telemetry`, the hub's own instance beacon, which is content-free and never sees a prompt or an answer.

## Where the rest lives

The dashboard, server, and self-hosting instructions are in the main repo: <https://github.com/relayroom/relayroom>.

## License

Apache-2.0
