import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
  /** The previous `target` when init last changed it. Lets rr.sh auto-rename a
   *  still-running session from the old name to the new one (e.g. when the naming
   *  convention changes), so the user never recreates the session by hand. */
  previousTarget?: string
  machineLabel?: string
  /** The coding CLI(s) to relaunch in the tmux session (e.g. "claude" or
   *  "claude,codex"); used by rr.sh. The first is launched in the session. */
  agent?: string
  /** Bearer token for MCP auth, so rr.sh can re-run `mcp add` after a reset. Local
   *  + gitignored (same secret the CLI already stores in .claude.json etc.). */
  token?: string
  /** Whether the turn-end usage hook may include the turn's content excerpts
   *  (the prompt's first 80 chars + the answer's last 500) alongside the token
   *  counts. Absent/true keeps the dashboard event showing the exchange; false
   *  reports counts only. Read by runtime/usage-report.mjs. */
  usageContent?: boolean
  /** Wake delivery path for the primary agent. "channel" => Claude Code Channels
   *  (the pager skips send-keys; the channel server pushes notifications). "headless"
   *  => the pager spawns the part's CLI (codex/agy) once per wake instead of typing
   *  into a tmux pane (no send-keys, no interactive session). "pager" or absent =>
   *  the pager's send-keys deferral (the default; the rollback target). Set by rr.sh
   *  at launch; read by the pager to choose its delivery path. */
  delivery?: "channel" | "pager" | "headless"
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
  const relayroomDir = join(resolve(dir), RELAYROOM_DIR)
  mkdirSync(relayroomDir, { recursive: true })
  const merged: Record<string, unknown> = { ...readConfig(dir) }
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined && v !== null && v !== "") merged[k] = v
  }
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n")
  // config.json holds the bearer token, so keep the dir + file owner-only. mkdir/write
  // `mode` is umask-masked AND a no-op on an already-existing path, so chmod explicitly
  // here - this also tightens files written by an older CLI before this fix. Best-effort:
  // chmod can fail on exotic filesystems (e.g. some Windows/network mounts).
  try { chmodSync(relayroomDir, 0o700) } catch { /* best-effort */ }
  try { chmodSync(path, 0o600) } catch { /* best-effort */ }
  return path
}
