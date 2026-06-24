import { spawnSync } from "node:child_process"
import { DEFAULT_SERVER } from "./constants"
import { type AgentId, mcpAddSpec, mcpAddCommand } from "./providers"

export interface ConnectOpts {
  code: string
  part: string
  agent?: AgentId
  server?: string
  name?: string
  run?: boolean
}

/** The MCP URL an agent connects to: <server>/mcp/<connect_code>?part=<part>. */
export function connectUrl(opts: ConnectOpts): string {
  const server = (opts.server ?? DEFAULT_SERVER).replace(/\/$/, "")
  return `${server}/mcp/${encodeURIComponent(opts.code)}?part=${encodeURIComponent(opts.part)}`
}

/**
 * Print (or, with --run, execute) the `<agent> mcp add` command that wires this
 * coding CLI into a RelayRoom project over MCP. Printing is the default so the
 * user sees exactly what will run. Works for Claude Code, Antigravity CLI (agy), and Codex.
 */
export function connect(opts: ConnectOpts): void {
  const agent: AgentId = opts.agent ?? "claude"
  const name = opts.name ?? "relayroom"
  const url = connectUrl(opts)

  if (opts.run) {
    const { bin, args } = mcpAddSpec(agent, name, url)
    const r = spawnSync(bin, args, { stdio: "inherit" })
    if (r.error) {
      const reason = (r.error as NodeJS.ErrnoException).code === "ENOENT"
        ? `the \`${bin}\` command was not found. Is ${agent} installed and on your PATH?`
        : r.error.message
      console.error(`error: could not run \`${bin} mcp add\`: ${reason}`)
      process.exit(1)
    }
    process.exit(r.status ?? 0)
  }

  console.log(mcpAddCommand(agent, name, url))
}
