/**
 * Agent providers RelayRoom's CLI knows how to wire up. Each is an MCP-capable
 * coding CLI with (1) an `mcp add` command and (2) a turn-end hook that passes a
 * transcript path on stdin - so the same RelayRoom integration ports across all
 * three, with per-provider command/config differences captured here.
 */
export type AgentId = "claude" | "gemini" | "codex"

export const AGENT_IDS: AgentId[] = ["claude", "gemini", "codex"]

export interface AgentInfo {
  id: AgentId
  /** Human label for docs / the dashboard picker. */
  label: string
  /** The CLI binary that registers MCP servers and fires hooks. */
  bin: string
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  claude: { id: "claude", label: "Claude Code", bin: "claude" },
  gemini: { id: "gemini", label: "Gemini CLI", bin: "gemini" },
  codex: { id: "codex", label: "Codex", bin: "codex" },
}

export function isAgentId(v: string): v is AgentId {
  return (AGENT_IDS as string[]).includes(v)
}

export interface McpAddSpec {
  bin: string
  args: string[]
}

/**
 * The `<bin> mcp add ...` argv that registers a streamable-HTTP MCP server.
 *
 * Claude and Gemini use `mcp add --scope project --transport http <name> <url>`.
 * `--scope project` is the fix for git worktrees: Claude's DEFAULT `local` scope is
 * keyed to the git repo root, so every worktree (android/web/...) shares ONE entry
 * and they all post as the same part. Project scope writes the server to the
 * worktree's `.mcp.json` instead, giving each worktree its own identity (the URL
 * carries `?part=`). Gemini already defaults to project; we pass it explicitly.
 *
 * Codex has no project scope - `mcp add` writes the global `~/.codex/config.toml` -
 * so per-worktree identity is not achievable through Codex's own MCP config.
 */
export function mcpAddSpec(agent: AgentId, name: string, url: string): McpAddSpec {
  switch (agent) {
    case "claude":
    case "gemini":
      return { bin: AGENTS[agent].bin, args: ["mcp", "add", "--scope", "project", "--transport", "http", name, url] }
    case "codex":
      return { bin: AGENTS.codex.bin, args: ["mcp", "add", name, "--url", url] }
  }
}

/** The full one-line `mcp add` command string (for printing / docs / the UI). */
export function mcpAddCommand(agent: AgentId, name: string, url: string): string {
  const { bin, args } = mcpAddSpec(agent, name, url)
  // Quote the URL since it contains `?` and `&`.
  const rendered = args.map((a) => (a === url ? `"${a}"` : a)).join(" ")
  return `${bin} ${rendered}`
}
