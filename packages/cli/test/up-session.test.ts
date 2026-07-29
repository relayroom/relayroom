import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { init } from "../src/init"
import { SUBPROCESS_TIMEOUT_MS } from "./timeouts"

/**
 * `up` is the command people type reflexively to make a part work, and it did none of
 * the three things that would: it never ran setup, it short-circuited entirely when a
 * session already existed - so a registration written after the session started was
 * never read - and it accepted `--bypass`/`--new` while applying neither, because the
 * only branch that consumes them is the one it skipped.
 *
 * The failure doctor cannot see is the middle one: every file on disk is correct and the
 * process that needed to read them started earlier, so doctor is truthfully green about
 * a session that will never work. These tests pin the liveness check, the refusal that
 * carries evidence rather than a conclusion, and the opt-in restart.
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

describe("generated rr.sh: up ensures setup and refuses a session that predates its config", () => {
  let dir: string
  let bin: string
  let env: NodeJS.ProcessEnv
  let savedTmux: string | undefined
  let hub: Server
  let hubUrl: string
  let session: string

  const calls = () => {
    try {
      return readFileSync(join(bin, "calls.log"), "utf8")
    } catch {
      return ""
    }
  }

  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $@" >> "${join(bin, "calls.log")}"\n${body}\n`, {
      mode: 0o755,
    })
    chmodSync(join(bin, name), 0o755)
  }

  /** Move a file's mtime to `secondsFromNow` relative to now. */
  const setMtime = (path: string, secondsFromNow: number) => {
    const t = new Date(Date.now() + secondsFromNow * 1000)
    utimesSync(path, t, t)
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-up-"))
    bin = mkdtempSync(join(tmpdir(), "relayroom-upbin-"))
    session = `RR-uptest-${process.pid}-${Math.floor(performance.now())}`
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
    await init({ dir, code: "c1", part: "core", server: hubUrl, token: "tok", tmuxCheck: false, target: session })
    // A claude that reports channels-unsupported, so prepare_launch stays on the pager
    // path and the launched "agent" is something that exits immediately.
    stub(
      "claude",
      `if [ "\${1:-}" = "--channels" ]; then echo "error: unknown option" >&2; exit 1; fi
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "add" ]; then
  _url=""; for _a in "$@"; do case "$_a" in http://*|https://*) _url="$_a"; break ;; esac; done
  node -e 'var fs=require("fs");var j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){}
j.mcpServers=j.mcpServers||{};j.mcpServers.relayroom={type:"http",url:process.argv[2]};
fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2))' "${join(dir, ".mcp.json")}" "$_url"
fi
exit 0`,
    )
    // The relayroom CLI itself: setup's hooks install, prepare_launch's delivery write,
    // and the pager. Real ones would reach the network and the user's own config.
    stub(
      "relayroom",
      `case "\${1:-}" in
  --version) echo "0.0.0-test" ;;
  delivery) node -e 'var fs=require("fs"),p=process.argv[1];var c=JSON.parse(fs.readFileSync(p,"utf8"));c.delivery=process.argv[2];fs.writeFileSync(p,JSON.stringify(c,null,2))' "${join(dir, ".relayroom/config.json")}" "\${2:-}" ;;
  pager) sleep 30 ;;
esac
exit 0`,
    )
  })

  afterEach(() => {
    run("tmux", ["kill-session", "-t", `=${session}`])
    hub.close()
    if (savedTmux !== undefined) process.env.TMUX = savedTmux
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })

  const up = (...flags: string[]) => run("bash", [join(dir, "rr.sh"), "up", ...flags], { cwd: dir, env })
  const makeSession = () => run("tmux", ["new-session", "-d", "-s", session, "sleep 300"])

  /**
   * A session whose process has exited but whose pane tmux kept, i.e. the state
   * `remain-on-exit on` produces.
   *
   * The test ARRANGES that option rather than inheriting it. An earlier version relied on
   * whatever the machine's tmux server happened to have set globally - it passed here
   * only because someone had turned it on to debug something else, and failed in CI where
   * the default `off` lets tmux destroy the session outright.
   *
   * Two details the arrangement depends on, both measured: `remain-on-exit` is a WINDOW
   * option (`set-option` alone does not take), and it has to be set while the process is
   * still alive - afterwards there is no window left to set it on. So the pane waits on a
   * file rather than exiting immediately.
   */
  const makeCorpse = async (status: number) => {
    const gate = join(dir, "corpse-gate")
    await run("tmux", ["new-session", "-d", "-s", session, `while [ ! -f ${gate} ]; do sleep 0.05; done; exit ${status}`])
    await new Promise((r) => setTimeout(r, 300))
    await run("tmux", ["set-window-option", "-t", `=${session}`, "remain-on-exit", "on"])
    writeFileSync(gate, "")
    // Wait for the pane to actually be dead rather than guessing at a delay.
    for (let i = 0; i < 60; i++) {
      const { stdout } = await run("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_dead}"])
      if (stdout.trim().split("\n").every((l) => l.trim() === "1")) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error("pane never became dead - remain-on-exit did not take")
  }

  it("runs setup on the way past, so a worktree that never had it registers", async () => {
    await up()
    expect(calls()).toMatch(/claude mcp add -s project/)
    expect(calls()).toMatch(/relayroom hooks install --agent claude/)
  })

  it("refuses a session that predates its .mcp.json, naming the evidence", async () => {
    await makeSession()
    // The session exists; the registration is written after it started.
    setMtime(join(dir, ".mcp.json"), 60)
    const { code, stderr } = await up()
    expect(code).toBe(1)
    expect(stderr).toContain("the running agent never read it")
    expect(stderr).toContain(".mcp.json written")
    // Says why doctor disagrees, which is the part that cost the owner three rounds.
    expect(stderr).toContain("doctor is green")
    expect(stderr).toContain("./rr.sh up --restart")
  })

  /**
   * setup rewrites .mcp.json on every run whether or not anything changed, so mtime
   * cannot answer "did setup change something just now" - only content can. Without this
   * the check would either miss a real change or fire on every invocation.
   */
  it("refuses when setup itself changed the config under a running session", async () => {
    setMtime(join(dir, ".mcp.json"), -600)
    await makeSession()
    // The stub writes a DIFFERENT url than the one already in .mcp.json, so setup's
    // rewrite is a genuine content change rather than a no-op.
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { relayroom: { url: "http://stale" } } }, null, 2))
    setMtime(join(dir, ".mcp.json"), -600)
    const { code, stderr } = await up()
    expect(code).toBe(1)
    expect(stderr).toContain("setup just changed this worktree's config")
    expect(stderr).toContain("./rr.sh up --restart")
  })

  it("does not refuse when setup's rewrite changed nothing", async () => {
    // Two runs: the first registers, the second rewrites .mcp.json with identical
    // content. Only a content check can tell the two apart.
    await up()
    await run("tmux", ["kill-session", "-t", `=${session}`])
    await makeSession()
    setMtime(join(dir, ".mcp.json"), -600)
    const { stderr } = await up()
    expect(stderr).not.toContain("setup just changed")
    expect(stderr).not.toContain("never read it")
  })

  it("does not refuse a session that is newer than its config", async () => {
    setMtime(join(dir, ".mcp.json"), -600)
    await makeSession()
    const { stderr } = await up()
    expect(stderr).not.toContain("never read it")
  })

  it("replaces the session on --restart instead of refusing", async () => {
    await makeSession()
    setMtime(join(dir, ".mcp.json"), 60)
    const { stdout } = await up("--restart")
    expect(stdout).toContain(`restarting session '${session}'`)
    expect(stdout).not.toContain("never read it")
  })

  it("errors rather than silently dropping --bypass on a running session", async () => {
    await makeSession()
    const { code, stderr } = await up("--bypass")
    expect(code).toBe(1)
    expect(stderr).toContain("--bypass")
    expect(stderr).toContain("would have no effect")
    expect(stderr).toContain("--restart")
  })

  it("errors rather than silently dropping --new on a running session", async () => {
    await makeSession()
    const { code, stderr } = await up("--new")
    expect(code).toBe(1)
    expect(stderr).toContain("--new")
    expect(stderr).toContain("would have no effect")
  })

  it("still applies --bypass when it creates the session, which is when it can", async () => {
    const { stdout, stderr } = await up("--bypass")
    expect(stderr).toContain("bypass: ON")
    expect(stdout).toContain(`starting session '${session}'`)
  })

  it("applies --bypass together with --restart, since that branch does create a session", async () => {
    await makeSession()
    const { stdout, stderr } = await up("--restart", "--bypass")
    expect(stderr).toContain("bypass: ON")
    expect(stdout).toContain(`restarting session '${session}'`)
    // The flag is applied, so it must not also be reported as having no effect.
    expect(stderr).not.toContain("would have no effect")
  })

  it("does not refuse a session it just restarted for being stale", async () => {
    await makeSession()
    setMtime(join(dir, ".mcp.json"), 60)
    const { stdout, stderr } = await up("--restart")
    expect(stdout).toContain(`restarting session '${session}'`)
    expect(stderr).not.toContain("never read it")
    expect(stderr).not.toContain("setup just changed")
  })

  /**
   * `remain-on-exit on` is what an operator turns on to find out why an agent keeps
   * dying. It stops tmux destroying the session, so `tx_exists` says yes for a corpse and
   * `up` would attach to a dead pane and report success - to precisely the person who is
   * mid-investigation. A corpse has no mid-turn work to lose, so it is replaced without
   * waiting for --restart, and its exit status is printed because that is the evidence
   * the flag was turned on to collect.
   */
  it("replaces a dead session kept alive by remain-on-exit, and reports its exit status", async () => {
    await makeCorpse(3)
    const { stdout } = await up()
    expect(stdout).toContain("is a corpse")
    expect(stdout).toContain("status 3")
    expect(stdout).toContain(`restarting session '${session}'`)
  })

  it("leaves a live session alone rather than treating it as a corpse", async () => {
    await makeSession()
    await run("tmux", ["set-window-option", "-t", `=${session}`, "remain-on-exit", "on"])
    const { stdout } = await up()
    expect(stdout).not.toContain("is a corpse")
    expect(stdout).not.toContain("restarting session")
  })
})
