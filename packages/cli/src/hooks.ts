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
  /** The worktree this part lives in. Only the statusLine needs it (it invokes that
   *  worktree's rr.sh), and it is explicit rather than derived from the settings path
   *  because `--settings` can point anywhere and a guessed worktree would write the
   *  parked user command into someone else's directory. */
  dir?: string
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
  enabledMcpjsonServers?: unknown
  [k: string]: unknown
}

/**
 * The servers RelayRoom itself registers in the worktree's `.mcp.json` - the board
 * and the wake channel. Approving them by name is deliberate: `enableAllProjectMcpServers`
 * would also trust whatever anyone else adds to that file later.
 */
export const RELAYROOM_MCP_SERVERS = ["relayroom", "relayroom-channel"] as const

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
 * The marker that makes our statusLine recognisable in someone else's settings file.
 * Matched as a substring, so the command can grow flags without the check going stale.
 */
export const STATUSLINE_MARKER = "statusline --claude"

/** Where a pre-existing user statusLine command is parked so ours can call it. */
export function userStatuslinePath(dir: string): string {
  return join(dir, ".relayroom", "statusline.user")
}

/**
 * Install RelayRoom's statusLine into Claude Code's settings, COMPOSING with whatever
 * the user already had.
 *
 * The bar (part, inbox, MCP, pager) was a tmux thing, and a herdr pane has no tmux bar.
 * Rebuilding it as a statusLine also buys a property the workspace token cannot have:
 * Claude Code POLLS this command, so the check runs in a different process from the
 * thing it checks and a dead pager turns the bar red on its own. A pushed token is only
 * as fresh as the last process alive to push it - it goes quiet exactly when it has
 * something to say.
 *
 * NEVER OVERWRITES. A user's own statusLine (dir/branch/model is the common one) is
 * parked in .relayroom/statusline.user and invoked by ours with the same stdin, so the
 * two compose instead of one replacing the other. Silently replacing it would be the
 * settings-file version of the session-rename bug: a configuration that belonged to
 * someone else, gone, with nothing failing.
 *
 * @returns what happened, so the caller can say it out loud rather than guess.
 */
export function statusLineUpdate(
  settings: AgentSettings,
  dir: string,
  userSettingsFile: string = join(homedir(), ".claude", "settings.json"),
): { action: "installed" | "composed" | "unchanged" | "skipped"; wrapped?: string; why?: string } {
  const script = join(dir, "rr.sh")
  const command = `"${script}" ${STATUSLINE_MARKER}`

  // ONLY POINT AT A SCRIPT THAT CAN ANSWER. rr.sh is generated per worktree and can be
  // older than the CLI installing this - and an rr.sh without `--claude` does not fail,
  // it falls through to the TMUX renderer and prints raw `#[fg=colour240]` markup into
  // Claude Code's bar. Measured exactly that way on a live worktree here. A capability
  // that is read from the file cannot drift; one that is assumed from the CLI's own
  // version can, because the two are updated at different times.
  let scriptSupports = false
  try { scriptSupports = readFileSync(script, "utf8").includes("sl_claude") } catch { scriptSupports = false }
  if (!scriptSupports) return { action: "skipped", why: `${script} has no --claude renderer (run ./rr.sh update --self first)` }

  const existing = settings.statusLine as { type?: unknown; command?: unknown } | undefined
  let existingCommand = typeof existing?.command === "string" ? existing.command : null

  // THE PROJECT FILE IS NOT THE ONLY PLACE A STATUSLINE LIVES, and this is where the
  // careless version of this function does its damage. Claude Code merges settings with
  // the project file winning, and people configure their bar once in
  // ~/.claude/settings.json - measured on this machine: the user had exactly that, and
  // the project file had no statusLine at all. Writing ours into the project file would
  // have overridden their global bar in every RelayRoom worktree while parking nothing,
  // because a function that only reads the file it edits sees an empty slot and calls it
  // free. So when the project file is silent, ask the user-level file before claiming it.
  if (!existingCommand) {
    try {
      const raw = JSON.parse(readFileSync(userSettingsFile, "utf8")) as AgentSettings
      const userLine = raw.statusLine as { command?: unknown } | undefined
      if (typeof userLine?.command === "string" && userLine.command.trim()) existingCommand = userLine.command
    } catch { /* no user settings, or not JSON - nothing to compose with */ }
  }

  // Already ours: leave it alone. Re-running install must not wrap our own wrapper -
  // that would park OUR command as "the user's" and every install would add a layer.
  if (existingCommand && existingCommand.includes(STATUSLINE_MARKER)) {
    return { action: "unchanged" }
  }

  let wrapped: string | undefined
  if (existingCommand) {
    // Park it. Written only when there is something to park, so a re-install after an
    // uninstall cannot resurrect a stale command.
    mkdirSync(dirname(userStatuslinePath(dir)), { recursive: true })
    writeFileSync(userStatuslinePath(dir), `${existingCommand}\n`)
    wrapped = existingCommand
  }
  settings.statusLine = { type: "command", command, padding: 0 }
  return { action: wrapped ? "composed" : "installed", wrapped }
}

/**
 * Merge the RelayRoom usage hook into an agent's JSON config file./**
 * Merge the RelayRoom usage hook into an agent's JSON config file. Any existing
 * RelayRoom hook (matched by usage-report.mjs) is replaced, not duplicated, so
 * re-running is idempotent. Other hooks and settings are preserved.
 */
export function installHook(opts: HookOpts): void {
  const agent = opts.agent ?? "claude"
  ensureUsageScript()

  const path = resolve(opts.settings ?? defaultSettings(agent))
  const event = hookEvent(agent)
  let statusLineNote: { action: string; wrapped?: string; why?: string } | null = null

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

    // Claude gates a project-scoped `.mcp.json` server behind an approval, and checks
    // it at STARTUP. An unattended agent has nobody to answer that prompt, so a
    // worktree that is registered but not approved comes back from its next relaunch
    // with no board AND no wake channel - and cannot report the condition, because
    // reporting it needs exactly the thing that is missing. Approving here is what
    // makes a fresh worktree usable with no human interaction.
    //
    // Merge, never replace: this is a project file that may already hold the user's
    // own approvals, and it is the same file the hooks above live in.
    const approved = new Set(
      Array.isArray(settings.enabledMcpjsonServers)
        ? settings.enabledMcpjsonServers.filter((s): s is string => typeof s === "string")
        : [],
    )
    for (const name of RELAYROOM_MCP_SERVERS) approved.add(name)
    settings.enabledMcpjsonServers = [...approved]

    // The in-pane status bar. Lives here rather than in its own command because it is
    // the same file, the same idempotent write, and the same "already current" check -
    // a second writer to settings.json is a second chance to clobber it.
    statusLineNote = statusLineUpdate(settings, resolve(opts.dir ?? process.cwd()))
  }

  // Write ONLY when the result differs. A no-op must be silent in every channel it can
  // speak through, and mtime is one of those channels: an unconditional rewrite is a lie
  // in the filesystem, and everything downstream that compares mtimes inherits it. `up`
  // decides whether a running session predates its own configuration by exactly that
  // comparison, and since `up` also runs setup, a no-op rewrite here would make every
  // session look stale forever.
  const next = `${JSON.stringify(settings, null, 2)}\n`
  let current: string | undefined
  try {
    current = readFileSync(path, "utf8")
  } catch {
    current = undefined
  }
  if (current === next) {
    console.log(`RelayRoom usage hook already current (${event}) -> ${path}`)
    // Say why there is no bar even when nothing else changed. A skipped statusLine is
    // invisible by construction - the absence of a status bar looks like a status bar
    // that has nothing to say - so the one line explaining it has to survive the
    // no-op path too.
    if (statusLineNote?.action === "skipped") console.log(`Skipped the RelayRoom statusLine: ${statusLineNote.why}`)
    if (agent === "codex") console.log(codexFeatureNote())
    return
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next)
  console.log(`Installed RelayRoom usage hook (${event}) -> ${path}`)
  if (agent === "claude") {
    console.log("Installed AskUserQuestion guard (PreToolUse, non-main only)")
    console.log(`Approved the RelayRoom MCP servers (${RELAYROOM_MCP_SERVERS.join(", ")}) so an unattended relaunch keeps its board and wakes`)
    if (statusLineNote?.action === "skipped") {
      console.log(`Skipped the RelayRoom statusLine: ${statusLineNote.why}`)
    } else if (statusLineNote?.action === "composed") {
      console.log(`Installed the RelayRoom statusLine AFTER your existing one (kept: ${statusLineNote.wrapped})`)
    } else if (statusLineNote?.action === "installed") {
      console.log("Installed the RelayRoom statusLine (part, inbox, MCP, pager)")
    }
  }

  if (agent === "codex") console.log(codexFeatureNote())
}
