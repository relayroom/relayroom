import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { type AgentId } from "./providers"
import { runtimePath } from "./runtime"

export interface HookOpts {
  code: string
  part: string
  agent?: AgentId
  server?: string
  /** Override the config file to edit; default depends on the agent. */
  settings?: string
}

// ── Where things live ────────────────────────────────────────────────────────

/**
 * Machine-global home for the usage reporter, shared by every project and agent
 * on this machine. Kept out of any project tree (no per-repo copy, no gitignore)
 * and out of npx's volatile cache, so the absolute path baked into a hook stays
 * valid after the npx download is garbage-collected.
 */
function usageScriptPath(): string {
  return join(homedir(), ".relayroom", "usage-report.mjs")
}

/** Copy the bundled usage reporter into ~/.relayroom (idempotent, kept fresh). */
function ensureUsageScript(): string {
  const dest = usageScriptPath()
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(runtimePath("usage-report.mjs"), dest)
  return dest
}

/** Machine-global home for the AskUserQuestion guard (Claude PreToolUse hook). */
function guardScriptPath(): string {
  return join(homedir(), ".relayroom", "relayroom-ask-guard.mjs")
}

/** Copy the bundled AskUserQuestion guard into ~/.relayroom (idempotent). */
function ensureGuardScript(): string {
  const dest = guardScriptPath()
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(runtimePath("relayroom-ask-guard.mjs"), dest)
  return dest
}

/** Turn-end hook event each agent fires; agy (Antigravity) calls it AfterAgent. */
function hookEvent(agent: AgentId): "Stop" | "AfterAgent" {
  return agent === "agy" ? "AfterAgent" : "Stop"
}

/** Default config file per agent (Claude/agy per-project, Codex global). */
function defaultSettings(agent: AgentId): string {
  switch (agent) {
    case "claude":
      return ".claude/settings.json"
    case "agy":
      return ".gemini/settings.json"
    case "codex":
      return join(homedir(), ".codex", "hooks.json")
  }
}

// ── Hook command + JSON block ────────────────────────────────────────────────

/**
 * The shell command the agent runs at the end of each turn. It reports the
 * turn's token usage to RelayRoom. `|| true` keeps a failed report from ever
 * blocking the agent; `--agent` tells the reporter which transcript format to
 * parse.
 *
 * The connect code is deliberately NOT baked in. It is a capability key (the
 * server authenticates /usage, /unread, /relayroom-md and the wake endpoints
 * with it), and this command lands in `.claude/settings.json` / `.gemini/
 * settings.json` - project files that teams commit, unlike everything else the
 * CLI writes, which init gitignores. The reporter resolves code/part from the
 * worktree's `.relayroom/config.json` (gitignored, chmod 600) instead, which is
 * already the recovery path for a restarted agent.
 *
 * Dropping it also fixes Codex: its hooks.json is GLOBAL, so a baked-in code
 * made every project on the machine report as whichever one ran install last.
 * Resolved from the turn's own directory, each project now reports as itself.
 */
export function hookCommand(opts: HookOpts): string {
  const agent = opts.agent ?? "claude"
  const script = usageScriptPath()
  // --server stays: it is not a secret, and an explicit --server must keep
  // winning over the saved config for a hook installed against another hub.
  const server = opts.server ? ` --server "${opts.server}"` : ""
  return `node "${script}" --agent ${agent}${server} || true`
}

interface HookGroup {
  matcher?: string
  hooks: { name?: string; type: string; command: string }[]
}
type HookMap = Record<string, HookGroup[] | undefined>
interface AgentSettings {
  hooks?: HookMap
  [k: string]: unknown
}

/**
 * One hook group for this agent. agy (like Gemini) requires a `matcher` on each group (and
 * accepts a `name`) - without it the group never fires, so usage+model never
 * report. Claude/Codex use the bare form they already work with.
 */
function hookGroup(opts: HookOpts): HookGroup {
  const entry = { type: "command", command: hookCommand(opts) }
  if ((opts.agent ?? "claude") === "agy") {
    return { matcher: "*", hooks: [{ name: "relayroom-usage", ...entry }] }
  }
  return { hooks: [entry] }
}

/** The hook block to merge for this agent (e.g. { hooks: { Stop: [...] } }). */
export function hookBlock(opts: HookOpts): { hooks: HookMap } {
  const event = hookEvent(opts.agent ?? "claude")
  return { hooks: { [event]: [hookGroup(opts)] } }
}

function codexFeatureNote(): string {
  return [
    "# Codex only loads hooks.json when hooks are enabled. If they are not yet,",
    "# add this to ~/.codex/config.toml:",
    "#   [features]",
    "#   hooks = true",
  ].join("\n")
}

export function printHook(opts: HookOpts): void {
  ensureUsageScript()
  const agent = opts.agent ?? "claude"
  console.log(`# ${agent}: merge into ${defaultSettings(agent)}`)
  console.log(JSON.stringify(hookBlock(opts), null, 2))
  if (agent === "codex") console.log(codexFeatureNote())
}

// ── Install ──────────────────────────────────────────────────────────────────

/**
 * Merge the RelayRoom usage hook into an agent's JSON config file. Any existing
 * RelayRoom hook (matched by usage-report.mjs) is replaced, not duplicated, so
 * re-running is idempotent. Other hooks and settings are preserved.
 */
export function installHook(opts: HookOpts): void {
  const agent = opts.agent ?? "claude"
  ensureUsageScript()

  const path = resolve(opts.settings ?? defaultSettings(agent))
  const event = hookEvent(agent)

  let settings: AgentSettings = {}
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8")) as AgentSettings
    } catch (err) {
      throw new Error(`config file is not valid JSON: ${path}: ${(err as Error).message}`)
    }
  }

  settings.hooks ??= {}
  const groups = (settings.hooks[event] ?? []).filter(
    (group) => !JSON.stringify(group).includes("usage-report.mjs"),
  )
  groups.push(hookGroup(opts))
  settings.hooks[event] = groups

  // Claude-only: a PreToolUse guard that blocks AskUserQuestion for non-main agents
  // (they have no human at their console). The guard fails OPEN, so the main agent is
  // never blocked. Other CLIs have no equivalent tool intercept and rely on
  // RELAYROOM.md's "Talking to the human" rule. Idempotent: replace, don't duplicate.
  if (agent === "claude") {
    const guard = ensureGuardScript()
    const pre = (settings.hooks["PreToolUse"] ?? []).filter(
      (group) => !JSON.stringify(group).includes("relayroom-ask-guard.mjs"),
    )
    pre.push({ matcher: "AskUserQuestion", hooks: [{ type: "command", command: `node "${guard}"` }] })
    settings.hooks["PreToolUse"] = pre
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
  console.log(`Installed RelayRoom usage hook (${event}) -> ${path}`)
  if (agent === "claude") console.log("Installed AskUserQuestion guard (PreToolUse, non-main only)")

  if (agent === "codex") console.log(codexFeatureNote())
}
