/**
 * Agent providers RelayRoom's CLI knows how to wire up. Each is an MCP-capable
 * coding CLI with (1) a way to register an MCP server and (2) a turn-end hook that
 * passes a transcript path on stdin - so the same RelayRoom integration ports across
 * all three, with per-provider command/config differences captured here.
 *
 * Note: Antigravity CLI (`agy`) replaced Google's Gemini CLI, which Google shut down
 * on 2026-06-18. agy reuses Gemini's `~/.gemini` config root and hook format, but it
 * has NO `mcp add` command - MCP servers are registered by editing a JSON config file.
 */
export type AgentId = "claude" | "agy" | "codex"

export const AGENT_IDS: AgentId[] = ["claude", "agy", "codex"]

export interface AgentInfo {
  id: AgentId
  /** Human label for docs / the dashboard picker. */
  label: string
  /** The CLI binary that registers MCP servers and fires hooks. */
  bin: string
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  claude: { id: "claude", label: "Claude Code", bin: "claude" },
  agy: { id: "agy", label: "Antigravity CLI", bin: "agy" },
  codex: { id: "codex", label: "Codex", bin: "codex" },
}

export function isAgentId(v: string): v is AgentId {
  return (AGENT_IDS as string[]).includes(v)
}

/**
 * agy registers MCP servers via a config FILE (~/.gemini/config/mcp_config.json),
 * not a CLI command. This node one-liner merges the relayroom server in, preserving
 * any other servers already configured. The bearer token is read from
 * `$RELAYROOM_TOKEN` (kept out of argv so it never lands in shell history). It takes
 * argv[1] = server URL and argv[2] = server name. Deliberately avoids template
 * literals / backticks so it embeds cleanly in the rr.sh shell template too.
 *
 * Uses `httpEndpoint` (NOT `serverUrl`): the relayroom MCP is Streamable HTTP, and
 * agy's only HTTP MCP connector is StreamableHTTPConnector, which keys off
 * `http_endpoint`. `serverUrl` matches no connector (agy has no legacy SSE one), so
 * the server hangs at "initializing" forever.
 */
export const AGY_MCP_MERGE_SCRIPT =
  'const fs=require("fs"),os=require("os"),path=require("path");' +
  // Fail fast (before touching the file) if no token, so we never overwrite a working
  // entry with an unusable empty `Bearer ` - e.g. `connect --run` without the env set.
  'if(!process.env.RELAYROOM_TOKEN){console.error("agy MCP: RELAYROOM_TOKEN not set");process.exit(1)}' +
  'const p=path.join(os.homedir(),".gemini","config","mcp_config.json");' +
  'fs.mkdirSync(path.dirname(p),{recursive:true});' +
  'let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8")||"{}")}catch(e){}' +
  'c.mcpServers=c.mcpServers||{};' +
  'c.mcpServers[process.argv[2]]={httpEndpoint:process.argv[1],headers:{Authorization:"Bearer "+(process.env.RELAYROOM_TOKEN||"")}};' +
  'fs.writeFileSync(p,JSON.stringify(c,null,2));' +
  'console.error("registered "+process.argv[2]+" in "+p)'

export interface McpAddSpec {
  bin: string
  args: string[]
}

/**
 * The argv that registers a streamable-HTTP MCP server for this agent.
 *
 * - Claude registers in PROJECT scope (`.mcp.json`, per-worktree). Claude's default
 *   `local` scope is keyed to the git repo root, so every worktree (android/web/...)
 *   would share ONE entry and post as the same part. Project scope gives each worktree
 *   its own identity (the URL carries `?part=`).
 * - Codex has no project scope (`mcp add` writes the global `~/.codex/config.toml`),
 *   so per-worktree identity is not achievable there.
 * - agy has no `mcp add` command at all; it reads `~/.gemini/config/mcp_config.json`.
 *   We merge into it via node (token from `$RELAYROOM_TOKEN`). Like Codex this is a
 *   global file, so per-worktree identity is not achievable for agy either.
 */
export function mcpAddSpec(agent: AgentId, name: string, url: string): McpAddSpec {
  switch (agent) {
    case "claude":
      return { bin: "claude", args: ["mcp", "add", "--scope", "project", "--transport", "http", name, url] }
    case "codex":
      return { bin: "codex", args: ["mcp", "add", name, "--url", url] }
    case "agy":
      return { bin: "node", args: ["-e", AGY_MCP_MERGE_SCRIPT, url, name] }
  }
}

/** The full one-line `mcp add` command string (for printing / docs / the UI). */
export function mcpAddCommand(agent: AgentId, name: string, url: string): string {
  if (agent === "agy") {
    // agy has no CLI command; show the node merge (token via $RELAYROOM_TOKEN).
    return `RELAYROOM_TOKEN=<token> node -e '${AGY_MCP_MERGE_SCRIPT}' "${url}" ${name}`
  }
  const { bin, args } = mcpAddSpec(agent, name, url)
  // Quote the URL since it contains `?` and `&`.
  const rendered = args.map((a) => (a === url ? `"${a}"` : a)).join(" ")
  return `${bin} ${rendered}`
}
