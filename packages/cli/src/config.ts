import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * `.relayroom/` is the per-worktree, machine-local RelayRoom state directory
 * (the operational sibling of `.claude/` / `.codex/` / `.gemini/`). RELAYROOM.md
 * stays at the worktree ROOT - it is the human+agent-visible playbook, like
 * CLAUDE.md. `.relayroom/config.json` holds this agent's connection identity so a
 * compacted or restarted agent (and the pager/usage hook) can recover it without
 * re-passing long flags or spending tokens re-discovering who it is.
 */
export const RELAYROOM_DIR = ".relayroom"

export interface RelayRoomConfig {
  code?: string
  part?: string
  server?: string
  target?: string
  /** Project slug from the hub (e.g. "digital-docent"). Used to name the tmux
   *  session deterministically as RR-<slug>-<part>. Cached so a re-init can keep
   *  the standard name even if the slug header is briefly unavailable. */
  projectSlug?: string
  machineLabel?: string
  /** The coding CLI(s) to relaunch in the tmux session (e.g. "claude" or
   *  "claude,codex"); used by rr.sh. The first is launched in the session. */
  agent?: string
  /** Bearer token for MCP auth, so rr.sh can re-run `mcp add` after a reset. Local
   *  + gitignored (same secret the CLI already stores in .claude.json etc.). */
  token?: string
  /** Wake delivery path for the primary agent. "channel" => Claude Code Channels
   *  (the pager skips send-keys; the channel server pushes notifications). "pager"
   *  or absent => the pager's send-keys deferral. Set by rr.sh at launch based on
   *  Channels availability; read by the pager to gate its flush. */
  delivery?: "channel" | "pager"
}

export function configPath(dir = "."): string {
  return join(resolve(dir), RELAYROOM_DIR, "config.json")
}

/** Read `.relayroom/config.json` from a worktree dir. Returns {} if absent/invalid. */
export function readConfig(dir = "."): RelayRoomConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(dir), "utf8")) as unknown
    return parsed && typeof parsed === "object" ? (parsed as RelayRoomConfig) : {}
  } catch {
    return {}
  }
}

/** Merge non-empty fields into `.relayroom/config.json` (creates the dir). */
export function writeConfig(dir: string, config: RelayRoomConfig): string {
  const path = configPath(dir)
  mkdirSync(join(resolve(dir), RELAYROOM_DIR), { recursive: true })
  const merged: Record<string, unknown> = { ...readConfig(dir) }
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined && v !== null && v !== "") merged[k] = v
  }
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n")
  return path
}
