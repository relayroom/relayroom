import { spawn } from "node:child_process"
import { Command, Option } from "commander"
import { connect } from "./connect"
import { installHook, printHook } from "./hooks"
import { init } from "./init"
import { runtimePath } from "./runtime"
import { DEFAULT_SERVER } from "./constants"
import { AGENT_IDS } from "./providers"
import { readConfig, writeConfig } from "./config"

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
  .requiredOption("--code <connect_code>", "project connect code")
  .option("--part <part>", "this agent's part (saved to .relayroom/config.json)")
  .option("--target <tmux>", "tmux target for the pager (saved to .relayroom/config.json)")
  .option("--agent <agent>", "coding CLI(s) to target, comma-separated (claude|codex|gemini)")
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
    const args = [
      "--code", need(o.code, "code"),
      "--part", need(o.part, "part"),
      "--target", need(o.target, "target"),
      "--server", o.server,
    ]
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

// ── channel: Claude Code Channels wake server (stdio MCP) ───────────────────────
program
  .command("channel")
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
  .description("Set the wake delivery mode (channel|pager) in .relayroom/config.json")
  .argument("<mode>", "channel or pager")
  .option("--dir <path>", "worktree directory", ".")
  .action((mode: string, opts: { dir: string }) => {
    if (mode !== "channel" && mode !== "pager") {
      console.error(`error: mode must be "channel" or "pager" (got "${mode}")`)
      process.exit(1)
    }
    const path = writeConfig(opts.dir, { delivery: mode })
    console.log(`delivery=${mode} -> ${path}`)
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
