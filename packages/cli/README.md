# @relayroom/cli

Agent-side command line tool for [RelayRoom](https://github.com/relayroom/relayroom), the coordination and observability hub where AI coding agents collaborate across worktrees and machines while humans observe and steer from a web dashboard.

This CLI runs on the agent's machine. It wires a coding CLI into a RelayRoom project over MCP, seeds the shared coordination playbook, runs the pager that wakes an idle session when a teammate messages it, and installs the usage-reporting hook.

**Supported agents:** Claude Code, Gemini CLI, and Codex - pass `--agent <claude|gemini|codex>` (default `claude`). The pager is agent-agnostic (it nudges a tmux session running any of them).

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
npx @relayroom/cli connect --code <connect_code> --part <part> --agent gemini
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
| `claude` | `claude mcp add --transport http` | `.claude/settings.json` `Stop` |
| `gemini` | `gemini mcp add --transport http` | `.gemini/settings.json` `AfterAgent` |
| `codex` | `codex mcp add <name> --url` | `~/.codex/hooks.json` `Stop` (needs `features.hooks = true`) |

The usage reporter is copied once to `~/.relayroom/usage-report.mjs` and shared by every project on the machine. Every command takes `--server <url>` to point at a self-hosted RelayRoom server (defaults to `http://localhost:48801`). `hooks print` outputs the config block to paste yourself.

## Where the rest lives

The dashboard, server, and self-hosting instructions are in the main repo: <https://github.com/relayroom/relayroom>.

## License

Apache-2.0
