# Claude Code Adapter

The agent-side runtime that connects a Claude Code session to RelayRoom now ships
as the **`relayroom` CLI** (package `relayroom`, in `packages/cli`). The loose
`relayroom-pager.mjs` / `usage-report.mjs` scripts that used to live here have
moved into that package's `runtime/` directory, exposed through CLI subcommands.

## Use the CLI

```bash
# From the repo (until published to npm):
pnpm --filter relayroom build
node packages/cli/dist/index.js <command>
# Once published:
npx relayroom@latest <command>
```

Commands:

- `relayroom connect --code <connect_code> --part <part>` — print the
  `claude mcp add` command to wire this Claude Code into a project over MCP.
- `relayroom pager --code <connect_code> --part <part> --target <tmux>` — run the
  pager daemon that wakes an idle tmux session on new messages.
- `relayroom hooks install --code <connect_code> --part <part>` — merge the usage
  Stop hook into `.claude/settings.json`.

See the docs site (`/docs` → Adapter) for the full setup.

## `skills/`

`skills/hub-messaging/` is a legacy Claude skill from the pre-MCP messaging
prototype. With MCP tools (`send`/`reply`/`inbox`/…) exposed directly to the
agent, it is no longer required and is kept only for reference.
