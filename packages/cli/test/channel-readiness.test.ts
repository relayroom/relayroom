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
  const decide = async () => {
    // `launch` ends in `exec sh -c "$LAUNCH"`, and LAUNCH is the stub, which exits 0.
    const { stdout, stderr } = await run("bash", [join(dir, "rr.sh"), "launch"], { cwd: dir, env })
    const delivery = JSON.parse(readFileSync(join(dir, ".relayroom", "config.json"), "utf8")).delivery
    return { out: stdout + stderr, delivery }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-chan-"))
    bin = mkdtempSync(join(tmpdir(), "relayroom-bin-"))
    savedTmux = process.env.TMUX
    delete process.env.TMUX
    env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
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

  it("takes channel mode when the server is observably connected", async () => {
    stubClaude({ list: "relayroom-channel: node ... - ✔ Connected" })
    const { out, delivery } = await decide()
    expect(delivery).toBe("channel")
    expect(out).toContain("wake delivery: channel")
    // Which layer decided, so a silently dead layer 1 is visible rather than covered for.
    expect(out).toContain("via observed")
  })

  /**
   * The flag matters, not just the mode. Measured: `--dangerously-load-development-channels`
   * stops on a confirmation prompt on EVERY launch, is not suppressed by
   * `--dangerously-skip-permissions`, and stores no consent - so an unattended relaunch
   * parks on it forever while the session looks healthy. `--channels` starts clean.
   */
  it("launches channel mode with --channels, never the prompting dangerous form", async () => {
    stubClaude({ list: "relayroom-channel: node ... - ✔ Connected" })
    await decide()
    const invoked = readFileSync(join(bin, "calls.log"), "utf8")
    expect(invoked).toMatch(/claude --channels server:relayroom-channel/)
    expect(invoked).not.toMatch(/--dangerously-load-development-channels/)
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
