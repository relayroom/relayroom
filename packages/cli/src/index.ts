import { spawn } from "node:child_process"
import { Command, Option } from "commander"
import { connect } from "./connect"
import { installHook, printHook } from "./hooks"
import { init } from "./init"
import { runtimePath } from "./runtime"
import { DEFAULT_SERVER } from "./constants"
import { AGENT_IDS } from "./providers"
import { readConfig, writeConfig } from "./config"
import { ensureWorkspace, findPane, herdrStatus, launchInPane } from "./herdr"
import { herdrCall } from "../runtime/herdr-client.mjs"
import { basename, resolve } from "node:path"

const agentOption = () =>
  new Option("--agent <agent>", "coding CLI to target")
    .choices(AGENT_IDS)
    .default("claude")

// Fields that `relayroom init` saves to .relayroom/config.json so other commands
// (and a compacted agent) can recover them without re-passing flags. Explicit
// flags win; then config; then the built-in default for the server.
function withConfig<T extends { code?: string; part?: string; target?: string; server?: string }>(
  opts: T,
): T & { server: string } {
  const cfg = readConfig(".")
  return {
    ...opts,
    code: opts.code ?? cfg.code,
    part: opts.part ?? cfg.part,
    target: opts.target ?? cfg.target,
    server: opts.server ?? cfg.server ?? DEFAULT_SERVER,
  }
}

function need(value: string | undefined, name: string): string {
  if (!value) {
    console.error(
      `error: --${name} is required (or run \`relayroom init --code <code>\` in this worktree first to save it to .relayroom/config.json)`,
    )
    process.exit(1)
  }
  return value
}

// Injected at build time by tsup from package.json, so `relayroom --version`
// always matches the published (lockstep) version.
declare const __CLI_VERSION__: string
const VERSION = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev"

const program = new Command()
  .name("relayroom")
  .description("RelayRoom agent-side CLI - connect, pager, usage hook")
  .version(VERSION, "-v, --version", "print the RelayRoom CLI version")

// ── connect: wire a coding CLI into a project over MCP ──────────────────────────
program
  .command("connect")
  .description("Print (or run) the `<agent> mcp add` command for a RelayRoom project")
  .option("--code <connect_code>", "project connect code (default: from .relayroom/config.json)")
  .option("--part <part>", "this agent's part (e.g. backend, web, alice)")
  .addOption(agentOption())
  .option("--server <url>", "RelayRoom server base URL")
  .option("--name <name>", "MCP server name registered in the agent", "relayroom")
  .option("--run", "run the `mcp add` command instead of just printing it", false)
  .action((opts) => {
    const o = withConfig(opts)
    connect({ ...o, code: need(o.code, "code"), part: need(o.part, "part") })
  })

// ── init: write RELAYROOM.md + .relayroom/config.json into this worktree ─────────
program
  .command("init")
  .description("Set up this worktree: write RELAYROOM.md + save connection identity to .relayroom/config.json")
  .option("--code <connect_code>", "project connect code (first time only; then reused from .relayroom/config.json)")
  .option("--part <part>", "this agent's part (saved to .relayroom/config.json; reused on re-init)")
  .option("--target <tmux>", "tmux target for the pager (saved to .relayroom/config.json)")
  .option("--agent <agent>", "coding CLI(s) to target, comma-separated (claude|codex|agy)")
  .option("--token <token>", "bearer token, saved to .relayroom/config.json so rr.sh can re-run mcp add")
  // No Commander default: a baked-in default would overwrite a previously-saved
  // custom server on every re-init. init() resolves explicit flag -> saved config ->
  // built-in default instead.
  .option("--server <url>", "RelayRoom server base URL")
  .option("--dir <path>", "worktree directory", ".")
  .option("--no-reference", "do not add @RELAYROOM.md to the agent instruction file")
  .option("--no-tmux-check", "skip the guard that requires running inside a tmux session")
  .action((opts) => init(opts))

// ── pager: wake an idle tmux session on new messages ────────────────────────────
program
  .command("pager")
  .description("Wake an idle Claude Code tmux session when RelayRoom messages arrive")
  .option("--code <connect_code>", "project connect code (default: from .relayroom/config.json)")
  .option("--part <part>", "this agent's part (default: from .relayroom/config.json)")
  .option("--target <tmux>", "tmux session, or session:window.pane, to wake (default: from .relayroom/config.json)")
  .option("--server <url>", "RelayRoom server base URL")
  .option("--debounce <ms>", "debounce window in milliseconds")
  .option("--token <token>", "bearer token, if the SSE endpoint requires auth")
  .action((opts) => {
    const o = withConfig(opts)
    // Headless delivery (codex/agy) spawns the CLI per wake instead of typing into a
    // tmux pane, so a tmux --target is not required. Every other mode keeps needing it.
    const cfg = readConfig(".")
    const headless = cfg.delivery === "headless"
    const args = [
      "--code", need(o.code, "code"),
      "--part", need(o.part, "part"),
      "--server", o.server,
    ]
    if (headless) {
      if (o.target) args.push("--target", o.target) // optional; used only for presence/status if present
      // The pager reads delivery/token from config.json too, but pass the CLI to spawn
      // explicitly (config.agent may be a comma list; the first entry is the primary).
      const cli = String(cfg.agent ?? "").split(",")[0]?.trim()
      if (cli) args.push("--agent-cli", cli)
    } else {
      args.push("--target", need(o.target, "target"))
    }
    if (o.debounce) args.push("--debounce", o.debounce)
    if (o.token) args.push("--token", o.token)
    // The pager is a long-lived foreground daemon; inherit stdio and mirror its
    // exit code so `relayroom pager` behaves exactly like running the script.
    const child = spawn(process.execPath, [runtimePath("relayroom-pager.mjs"), ...args], {
      stdio: "inherit",
    })
    // Forward kills to the child. rr.sh tracks THIS wrapper's pid; without forwarding,
    // `./rr.sh pager stop/restart` kills the wrapper but ORPHANS the node pager child
    // -> duplicate pagers pile up and storm the agent.
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig))
    child.on("exit", (code) => process.exit(code ?? 0))
  })

// ── channel-server: Claude Code Channels wake server (stdio MCP) ────────────────
// Named `channel-server`, not `channel`, because 0.6.1 added `channel on|off` for the
// INTENT and commander throws at registration when two commands share a name - which
// killed every CLI invocation, including the launcher's, so no agent could start. The
// server keeps the renamed form rather than the intent giving way: `.mcp.json` spawns
// `relayroom-channel.mjs` directly on every worktree checked, so this wrapper had no
// callers, while `channel on|off` is already referenced by `rr.sh --channel`, the 0.6.1
// release notes, and config.ts. Renaming the one nobody calls costs nothing.
program
  .command("channel-server")
  .description("Run the RelayRoom Claude Channels server (stdio MCP; invoked by Claude via .mcp.json)")
  .option("--code <connect_code>", "project connect code (default: from .relayroom/config.json)")
  .option("--part <part>", "this agent's part (default: from .relayroom/config.json)")
  .option("--server <url>", "RelayRoom server base URL")
  .option("--token <token>", "bearer token, if the stream requires auth")
  .action((opts) => {
    const o = withConfig(opts)
    const args = [
      "--code", need(o.code, "code"),
      "--part", need(o.part, "part"),
      "--server", o.server,
    ]
    if (o.token) args.push("--token", o.token)
    // stdio is the MCP transport between Claude and the channel server; inherit it
    // verbatim (stdout carries JSON-RPC, stderr carries logs).
    const child = spawn(process.execPath, [runtimePath("relayroom-channel.mjs"), ...args], {
      stdio: "inherit",
    })
    // Forward kills so the channel server child dies with this wrapper (no orphans).
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig))
    child.on("exit", (code) => process.exit(code ?? 0))
  })

// ── delivery: set the wake delivery mode in .relayroom/config.json ──────────────
program
  .command("delivery")
  .description("Set the wake delivery mode (channel|pager|headless) in .relayroom/config.json")
  .argument("<mode>", "channel, pager, or headless")
  .option("--dir <path>", "worktree directory", ".")
  .action((mode: string, opts: { dir: string }) => {
    if (mode !== "channel" && mode !== "pager" && mode !== "headless") {
      console.error(`error: mode must be "channel", "pager", or "headless" (got "${mode}")`)
      process.exit(1)
    }
    const path = writeConfig(opts.dir, { delivery: mode })
    console.log(`delivery=${mode} -> ${path}`)
  })

// ── herdr: the verbs rr.sh needs from the socket API ───────────────────────────
// One command with subcommands rather than several, because the shell calls them the
// same way and a single `herdr` namespace keeps the CLI's top level from growing a verb
// per multiplexer. Every one prints ONE line the script can read; nothing here is meant
// for a human to parse twice.
const herdrCmd = program
  .command("herdr")
  .description("herdr multiplexer helpers used by rr.sh (socket API)")

herdrCmd
  .command("status")
  .description("Whether herdr is usable here, and whether this worktree has a pane with an agent in it")
  .option("--dir <path>", "worktree directory", ".")
  .action(async (opts: { dir: string }) => {
    const st = await herdrStatus(resolve(opts.dir))
    // A shell reads fields, not prose: `key=value` on one line, and `usable` first so a
    // caller can branch on it without parsing the rest.
    console.log(
      [
        `usable=${st.usable}`,
        st.version ? `version=${st.version}` : "",
        `pane=${st.pane?.pane_id ?? "none"}`,
        `agent=${st.agent ? "yes" : "no"}`,
        st.reason ? `reason=${JSON.stringify(st.reason)}` : "",
      ].filter(Boolean).join(" "),
    )
    if (!st.usable) process.exit(1)
  })

herdrCmd
  .command("ensure")
  .description("Make sure a herdr workspace exists for this worktree (grouped under the repo when it is a git worktree)")
  .option("--dir <path>", "worktree directory", ".")
  .option("--label <label>", "workspace label")
  .action(async (opts: { dir: string; label?: string }) => {
    const dir = resolve(opts.dir)
    const cfg = readConfig(opts.dir)
    const label = opts.label ?? cfg.target ?? cfg.part ?? basename(dir)
    const { pane, created, grouped, why } = await ensureWorkspace(dir, label)
    console.log(
      `pane=${pane.pane_id} workspace=${pane.workspace_id} created=${created} grouped=${grouped}` +
        (grouped || !why ? "" : ` reason=${JSON.stringify(why)}`),
    )
  })

herdrCmd
  .command("launch")
  .description("Type a launch command into this worktree's pane and confirm an agent actually started")
  .argument("<command>", "the command to run in the pane")
  .option("--dir <path>", "worktree directory", ".")
  .action(async (command: string, opts: { dir: string }) => {
    const pane = await findPane(resolve(opts.dir))
    if (!pane) {
      console.error(`error: no herdr pane has cwd ${resolve(opts.dir)} - run \`relayroom herdr ensure\` first`)
      process.exit(1)
    }
    // Confirmed by watching the pane's processes, never by the response to send_keys:
    // herdr answers "ok" to input it delivered nowhere.
    const started = await launchInPane(pane.pane_id, command)
    console.log(`pane=${pane.pane_id} started=${started}`)
    if (!started) process.exit(1)
  })

herdrCmd
  .command("close")
  .description("Close this worktree's herdr workspace (the equivalent of killing its tmux session)")
  .option("--dir <path>", "worktree directory", ".")
  .action(async (opts: { dir: string }) => {
    const pane = await findPane(resolve(opts.dir))
    if (!pane) { console.log("pane=none closed=false"); return }
    await herdrCall("workspace.close", { workspace_id: pane.workspace_id })
    console.log(`workspace=${pane.workspace_id} closed=true`)
  })

herdrCmd
  .command("focus")
  .description("Bring this worktree's herdr workspace to the front")
  .option("--dir <path>", "worktree directory", ".")
  .action(async (opts: { dir: string }) => {
    const pane = await findPane(resolve(opts.dir))
    if (!pane) { console.error("error: no herdr pane for this worktree"); process.exit(1) }
    await herdrCall("workspace.focus", { workspace_id: pane.workspace_id })
    console.log(`workspace=${pane.workspace_id} focused=true`)
  })

// ── channel: the INTENT to use Claude Code Channels (not the current mode) ──────
// Two commands, not one field, because the outage this comes from was a single field
// carrying both "what was asked for" and "what is running". `delivery` remains the
// measured mode; this is the standing wish, and only a human writes it.
program
  .command("channel")
  .description("Turn Claude Code Channels on or off for this worktree (intent; delivery reports the actual mode)")
  .argument("<state>", "on or off")
  .option("--dir <path>", "worktree directory", ".")
  .action((state: string, opts: { dir: string }) => {
    if (state !== "on" && state !== "off") {
      console.error(`error: state must be "on" or "off" (got "${state}")`)
      process.exit(1)
    }
    const path = writeConfig(opts.dir, { channel: state === "on" })
    console.log(`channel=${state === "on"} -> ${path}`)
    if (state === "on") {
      console.log("channels need a tmux pane (the launch stops on a confirmation prompt).")
      console.log("Run ./rr.sh up --restart for it to take effect.")
    }
  })

program
  .command("multiplexer")
  .description("Choose the multiplexer this worktree's part runs under (intent, persisted)")
  .argument("<name>", "tmux or herdr")
  .option("--dir <path>", "worktree directory", ".")
  .action((name: string, opts: { dir: string }) => {
    if (name !== "tmux" && name !== "herdr") {
      console.error(`error: multiplexer must be "tmux" or "herdr" (got "${name}")`)
      process.exit(1)
    }
    // Written even for "tmux", rather than deleting the key. Absent and "tmux" behave
    // identically at read time, but they are different FACTS: absent is "nobody has
    // chosen", "tmux" is "someone chose tmux" - which is what a rollback is. Losing that
    // distinction would make a rolled-back worktree indistinguishable from one that was
    // never migrated, and the rollback is exactly the moment somebody will ask.
    const path = writeConfig(opts.dir, { multiplexer: name })
    console.log(`multiplexer=${name} -> ${path}`)
  })

// ── hooks: manage the per-agent usage turn-end hook ─────────────────────────────
const hooks = program.command("hooks").description("Manage the RelayRoom usage hook")

hooks
  .command("install")
  .description("Wire the RelayRoom usage hook into the agent's config")
  .option("--code <connect_code>", "project connect code (default: from .relayroom/config.json)")
  .option("--part <part>", "this agent's part (default: from .relayroom/config.json)")
  .addOption(agentOption())
  .option("--server <url>", "RelayRoom server base URL")
  .option("--settings <path>", "config file to edit (default depends on --agent)")
  .option("--dir <path>", "worktree directory (the statusLine calls its rr.sh)", ".")
  .action((opts) => {
    const o = withConfig(opts)
    installHook({ ...o, code: need(o.code, "code"), part: need(o.part, "part") })
  })

hooks
  .command("print")
  .description("Print the usage hook config block (paste it into the agent config yourself)")
  .option("--code <connect_code>", "project connect code (default: from .relayroom/config.json)")
  .option("--part <part>", "this agent's part (default: from .relayroom/config.json)")
  .addOption(agentOption())
  .option("--server <url>", "RelayRoom server base URL")
  .action((opts) => {
    const o = withConfig(opts)
    printHook({ ...o, code: need(o.code, "code"), part: need(o.part, "part") })
  })

program.parseAsync(process.argv)
