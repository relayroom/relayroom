/**
 * Pure builders for the pager's HEADLESS delivery mode (delivery=headless). Instead of
 * tmux send-keys, the pager spawns the part's CLI once per wake so the agent processes
 * its inbox via the RelayRoom MCP tools with no interactive session. Kept side-effect-free
 * and unit-testable, like pager-text.mjs (the pager parses argv + runs main() on import).
 *
 * Applies to codex and agy ONLY. claude never runs headless here (it uses Channels or the
 * send-keys pager); headlessSpawnSpec returns null for it so a misconfigured part fails
 * closed (logged + re-queued) rather than shelling out to the wrong CLI.
 */

/**
 * The instruction the headless agent runs. Mirrors buildText's etiquette (read via the
 * `inbox` MCP tool, reply only when an answer is needed, `ack` otherwise, close when
 * resolved) so a headless part behaves the same as a send-keys one. The peer-controlled
 * subject is deliberately NOT embedded: this string is a process argv (no tmux keystroke
 * injection surface), and the agent reads the real messages itself via the inbox tool, so
 * there is nothing to gain from pasting an unverified subject into the prompt.
 */
export function buildHeadlessPrompt(batch, wakeId, part) {
  const n = (batch ?? []).reduce((s, e) => s + (e?.count ?? 1), 0)
  const tag = wakeId ? ` (wake ${String(wakeId).slice(0, 8)})` : ""
  return (
    `You have ${n} unread RelayRoom message${n === 1 ? "" : "s"}${tag} for part "${part}". ` +
    "Use the RelayRoom `inbox` MCP tool to read them (NOT curl/shell - the HTTP API 404s " +
    "and won't mark anything read). Reply ONLY if an answer is needed; otherwise `ack` the " +
    "message. Do NOT reply just to acknowledge or confirm. Close each thread once it is " +
    "resolved. If nothing is unread, stop without sending anything."
  )
}

/**
 * Map an agent CLI name to the headless spawn spec ({ command, args, env }) for one wake.
 *
 *   codex: `codex exec --profile relayroom <prompt>`. The relayroom MCP is a streamable
 *          HTTP server with no static-token option, so codex reads its bearer from the
 *          RELAYROOM_TOKEN env var (bearer_token_env_var). We inject it into the child env.
 *   agy:   `agy -p <prompt>`. `rr.sh agy mcp-add` bakes the bearer into
 *          ~/.gemini/config/mcp_config.json, so no env injection is needed.
 *
 * Returns null for any other CLI (claude, empty, unknown) so the caller fails closed.
 */
export function headlessSpawnSpec(agentCli, { token, prompt } = {}) {
  const cli = String(agentCli ?? "").trim()
  if (cli === "codex") {
    return {
      command: "codex",
      args: ["exec", "--profile", "relayroom", String(prompt ?? "")],
      env: token ? { RELAYROOM_TOKEN: String(token) } : {},
    }
  }
  if (cli === "agy") {
    return { command: "agy", args: ["-p", String(prompt ?? "")], env: {} }
  }
  return null
}
