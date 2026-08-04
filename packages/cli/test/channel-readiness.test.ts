import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { init } from "../src/init"
import { SUBPROCESS_TIMEOUT_MS } from "./timeouts"

/**
 * `prepare_launch` used to select channel mode from whether Claude Code HAS the
 * `--channels` flag - someone else's feature flag - and treat that as evidence that
 * OUR channel server would load. When the two diverged the result was the worst shape
 * available rather than a visible failure: `delivery=channel` written to config, the
 * channel silently absent (claude does not exit or warn), and the pager returning
 * before `wake.subscribe` - so nothing delivered while the heartbeat kept the status
 * bar green. These tests pin that channel mode now requires positive evidence and that
 * every other outcome degrades to pager.
 */

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: SUBPROCESS_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

describe("generated rr.sh: channel mode requires evidence, not a feature flag", () => {
  let dir: string
  let bin: string
  let env: NodeJS.ProcessEnv
  let savedTmux: string | undefined
  let hub: Server
  let hubUrl: string

  /**
   * A stub `claude`. `channels` controls whether the capability probe reports the flag
   * exists; `list` is the `mcp list` line for relayroom-channel, or "" to make the
   * observable layer unable to answer at all.
   */
  const stubClaude = (opts: { channels?: boolean; list?: string }) => {
    const channels = opts.channels !== false
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash
echo "claude $@" >> "${join(bin, "calls.log")}"
# The PROBE is \`--channels\` with no value; a real launch passes one. Distinguishing them
# is what lets a test see which flag the launch actually used.
if [ "\${1:-}" = "--channels" ] && [ -z "\${2:-}" ]; then
  ${channels ? `echo "error: option '--channels <servers...>' argument missing" >&2` : `echo "error: unknown option '--channels'" >&2`}
  exit 1
fi
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "list" ]; then
  ${opts.list === undefined || opts.list === "" ? ":" : `echo ${JSON.stringify(opts.list)}`}
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    )
    chmodSync(join(bin, "claude"), 0o755)
  }

  /** Run `rr.sh launch` far enough to make the decision, without execing an agent. */
  /**
   * `inPane` is not a detail. Channel mode now requires a tmux pane, because the launch
   * form it needs stops on a confirmation prompt and something has to press Enter. The
   * `launch` path runs inside the session, so TMUX set is what "there is a pane" means
   * there; a test that forgets it is testing the headless case.
   */
  const decide = async (opts: { inPane?: boolean; wanted?: boolean } = {}) => {
    // Channels are OPT-IN now, so every case about "which mode is chosen" is a case
    // about a worktree that asked for channels. Default true here, with the opposite
    // pinned separately below - a suite where the default were false would test the
    // same branch over and over without noticing.
    const cfgPath = join(dir, ".relayroom", "config.json")
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
    cfg.channel = opts.wanted !== false
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    const useEnv = opts.inPane === false ? env : { ...env, TMUX: "/tmp/tmux-test,1,0" }
    // `launch` ends in `exec sh -c "$LAUNCH"`, and LAUNCH is the stub, which exits 0.
    const { stdout, stderr } = await run("bash", [join(dir, "rr.sh"), "launch"], { cwd: dir, env: useEnv })
    const delivery = JSON.parse(readFileSync(join(dir, ".relayroom", "config.json"), "utf8")).delivery
    return { out: stdout + stderr, delivery }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-chan-"))
    bin = mkdtempSync(join(tmpdir(), "relayroom-bin-"))
    savedTmux = process.env.TMUX
    delete process.env.TMUX
    env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RR_CHANNEL_WATCH_TICKS: "1" }
    delete env.TMUX
    hub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown", "x-relayroom-project-slug": "demo" })
      res.end("# RELAYROOM.md\n")
    })
    hubUrl = await new Promise<string>((resolve) => {
      hub.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(hub.address() as { port: number }).port}`))
    })
    await init({ dir, code: "c1", part: "core", server: hubUrl, token: "tok", tmuxCheck: false, target: "RR-chan" })
  })

  afterEach(() => {
    hub.close()
    if (savedTmux !== undefined) process.env.TMUX = savedTmux
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })

  /**
   * THE DEFAULT, and it is the whole point of the release. Channels are a research
   * preview we do not control - the flag changed once already, the confirmation prompt's
   * wording can change without notice, and under `-p` the flag is ignored outright. The
   * pager needs none of that. So the question stopped being "can we use channels" and
   * became "did anyone ask for them", and the answer decides before any evidence is
   * gathered: nothing here even probes claude when the intent is off.
   */
  it("delivers by pager when nobody asked for channels, however good the evidence", async () => {
    stubClaude({ list: "relayroom-channel: node ... - ✔ Connected" })
    const { delivery } = await decide({ wanted: false })
    expect(delivery).toBe("pager")
    // The capability probe is not even run - the decision does not depend on it.
    const invoked = readFileSync(join(bin, "calls.log"), "utf8")
    expect(invoked).not.toMatch(/claude --channels/)
  })

  it("takes channel mode when the server is observably connected", async () => {
    stubClaude({ list: "relayroom-channel: node ... - ✔ Connected" })
    const { out, delivery } = await decide()
    expect(delivery).toBe("channel")
    expect(out).toContain("wake delivery: channel")
    // Which layer decided, so a silently dead layer 1 is visible rather than covered for.
    expect(out).toContain("via observed")
  })

  /**
   * REWRITTEN, and the direction of the flip is the finding. This case used to assert
   * `--channels server:relayroom-channel` and forbid the dangerous form, on the measured
   * grounds that the dangerous form prompts on every launch. The measurement was right
   * and the conclusion was wrong: during the preview `--channels` accepts only PLUGINS on
   * an allowlist, whose entries are {marketplace, plugin} pairs, and we pass a bare MCP
   * server from .mcp.json - a shape that cannot appear on any allowlist. claude does not
   * fail; it starts, connects the server, and drops notifications with one line in its
   * own log. A four-part project lost every wake for hours with a green status bar.
   *
   * So the trade was a VISIBLE failure (a session parked on a prompt) for an INVISIBLE
   * one, and the prompt is answerable - see the watcher tests below.
   */
  it("launches channel mode with the development flag, never --channels for a bare server", async () => {
    stubClaude({ list: "relayroom-channel: node ... - ✔ Connected" })
    await decide()
    const invoked = readFileSync(join(bin, "calls.log"), "utf8")
    expect(invoked).toMatch(/claude --dangerously-load-development-channels server:relayroom-channel/)
    // The probe still runs (it asks whether channels exist at all); what must never
    // appear is a LAUNCH naming the server after --channels.
    expect(invoked).not.toMatch(/claude --channels server:/)
  })

  it("stays on pager when there is no tmux pane to answer the prompt", async () => {
    // The headless case, and the reason channel mode is now conditional on something
    // other than the server being loadable: the launch form it needs stops on a prompt,
    // and with no pane the agent would sit on it while the session looked alive. Pager
    // needs no terminal. (claude ignores the dev flag under `-p` for the same reason:
    // `if (!isNonInteractive && devChannels?.length)`.)
    stubClaude({ list: "relayroom-channel: node ... - ✔ Connected" })
    const { out, delivery } = await decide({ inPane: false })
    expect(delivery).toBe("pager")
    // LOUD, not quiet. Channels are opt-in now, so there is a person who turned this on
    // and a silent downgrade would leave their setting true while nothing used it - the
    // same disease pointing the other way.
    expect(out).toContain("channel is ON for this worktree")
    expect(out).toContain("--no-channel")
    // And it survives the launch scrolling away.
    const state = readFileSync(join(dir, ".relayroom", "channel.state"), "utf8")
    expect(state).toContain("refused no-tmux-pane")
  })

  /**
   * The evidence layer that did not exist during the outage. `claude mcp list` said
   * Connected the whole time - true, and about a different question. These lines are
   * claude reporting what it did with the notifications themselves.
   */
  it("reads claude's own log as the strongest evidence of delivery", async () => {
    stubClaude({ list: "" }) // the observable layer cannot answer; the log must carry it
    const home = mkdtempSync(join(tmpdir(), "relayroom-home-"))
    // These two drive rr.sh directly (they need a custom HOME), so they set the opt-in
    // themselves - decide() is what normally does it.
    const cfgPath = join(dir, ".relayroom", "config.json")
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), channel: true }, null, 2))
    const logDir = join(home, ".cache", "claude-cli-nodejs", dir.replace(/[^A-Za-z0-9]/g, "-"), "mcp-logs-relayroom-channel")
    mkdirSync(logDir, { recursive: true })
    writeFileSync(join(logDir, "a.jsonl"), JSON.stringify({ debug: "Channel notifications registered" }) + "\n")
    try {
      const { stdout, stderr } = await run("bash", [join(dir, "rr.sh"), "launch"], {
        cwd: dir,
        env: { ...env, HOME: home, TMUX: "/tmp/tmux-test,1,0" },
      })
      const delivery = JSON.parse(readFileSync(join(dir, ".relayroom", "config.json"), "utf8")).delivery
      expect(delivery).toBe("channel")
      expect(stdout + stderr).toContain("via delivered")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  /**
   * A stale `skipped` must NOT veto the next launch, and this is the subtle half of the
   * rule. That line describes the launch form that produced it - and the form that
   * produced every one of them (`--channels server:`) is the one this release removed.
   * Reading it as a verdict about the worktree would make one bad launch permanent.
   */
  it("does not treat a skip from a previous launch form as a verdict", async () => {
    stubClaude({ list: "relayroom-channel: node ... - ✔ Connected" })
    const home = mkdtempSync(join(tmpdir(), "relayroom-home-"))
    // These two drive rr.sh directly (they need a custom HOME), so they set the opt-in
    // themselves - decide() is what normally does it.
    const cfgPath = join(dir, ".relayroom", "config.json")
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), channel: true }, null, 2))
    const logDir = join(home, ".cache", "claude-cli-nodejs", dir.replace(/[^A-Za-z0-9]/g, "-"), "mcp-logs-relayroom-channel")
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, "a.jsonl"),
      JSON.stringify({ debug: "Channel notifications skipped: server relayroom-channel is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)" }) + "\n",
    )
    try {
      const { stdout, stderr } = await run("bash", [join(dir, "rr.sh"), "launch"], {
        cwd: dir,
        env: { ...env, HOME: home, TMUX: "/tmp/tmux-test,1,0" },
      })
      const delivery = JSON.parse(readFileSync(join(dir, ".relayroom", "config.json"), "utf8")).delivery
      expect(delivery).toBe("channel")
      // Decided by the observable layer, not by the stale log line.
      expect(stdout + stderr).toContain("via observed")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  /** The exact fleet-wide case: the flag exists, the server is pending approval. */
  it("falls back to pager when the server is pending approval, and names the fix", async () => {
    stubClaude({ list: "relayroom-channel: node ... - ⏸ Pending approval (run `claude` to approve)" })
    const { out, delivery } = await decide()
    expect(delivery).toBe("pager")
    expect(out).toContain("wake delivery: pager")
    expect(out).toContain("not approved")
    expect(out).toContain("./rr.sh setup")
  })

  it("uses the approval keys when the observable layer cannot answer", async () => {
    // No relayroom-channel line at all from `mcp list`; approval present on disk.
    stubClaude({ list: "" })
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ enabledMcpjsonServers: ["relayroom", "relayroom-channel"] }),
    )
    const { out, delivery } = await decide()
    expect(delivery).toBe("channel")
    expect(out).toContain("via settings")
  })

  it("falls back to pager when the keys say the server is unapproved", async () => {
    stubClaude({ list: "" })
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: [] }))
    const { out, delivery } = await decide()
    expect(delivery).toBe("pager")
    expect(out).toContain("via settings")
  })

  /**
   * The structural point: channel mode requires positive evidence, so a probe failing
   * in a way nobody anticipated degrades to send-keys rather than to silence.
   */
  it("falls back to pager when no layer can produce evidence", async () => {
    stubClaude({ list: "" })
    rmSync(join(dir, ".mcp.json"), { force: true })
    const { out, delivery } = await decide()
    expect(delivery).toBe("pager")
    expect(out).toContain("could not be confirmed loadable")
  })

  it("stays on pager when Claude Code has no channels support at all", async () => {
    stubClaude({ channels: false, list: "relayroom-channel: node ... - ✔ Connected" })
    const { out, delivery } = await decide()
    expect(delivery).toBe("pager")
    // Nothing to explain: the capability is absent, so no channel decision was made.
    expect(out).not.toContain("not approved")
  })
})
