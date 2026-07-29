import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, utimesSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
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
  let socket: string
  const bins: string[] = []

  /**
   * Every tmux call goes to a PRIVATE server, not the developer's.
   *
   * This is a guard rather than a note, and it is here because a note already failed.
   * These tests twice passed for a reason that was not in them: the machine had
   * `remain-on-exit on` set globally to debug something else, which both made a corpse
   * test green that CI failed, and kept sessions alive that would otherwise have died.
   * The lesson was written down after the first time and not applied the second - so the
   * fix cannot be remembering it.
   *
   * A fresh private server starts with tmux's defaults, which is exactly CI's condition, so
   * an ambient global cannot reach these tests at all. It also makes cleanup total: kill
   * the server and nothing survives, including a detached respawn that would otherwise
   * race teardown and recreate its session on the developer's server.
   */
  const tmux = (args: string[]) => run("tmux", ["-S", socket, ...args])

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
    // -S, a path inside the test's own temp dir, rather than -L: a named socket lives in
    // tmux's shared directory and its inode outlives `kill-server`, so every run would leave
    // one behind. Here it is removed with the directory.
    socket = join(bin, "tmux.sock")
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
      `case "\${1:-}" in
  --channels) echo "error: unknown option" >&2; exit 1 ;;
  mcp)
    if [ "\${2:-}" = "add" ]; then
      _url=""; for _a in "$@"; do case "$_a" in http://*|https://*) _url="$_a"; break ;; esac; done
      node -e 'var fs=require("fs");var j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){}
j.mcpServers=j.mcpServers||{};j.mcpServers.relayroom={type:"http",url:process.argv[2]};
fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2))' "${join(dir, ".mcp.json")}" "$_url"
    fi
    exit 0 ;;
esac
# Reached only when launched AS THE AGENT (rr.sh runs \`claude --continue || claude\`):
# stay alive, like a real one. An immediate exit made the session's survival depend on
# \`remain-on-exit\` being set ambiently - the same inherited-environment bug that turned
# CI red, so these tests hold the session open themselves rather than relying on the
# machine. Every non-agent subcommand must exit above, or rr.sh blocks on this sleep.
sleep 120`,
    )
    // rr.sh runs `tmux` itself, so it needs the same private server the test uses -
    // otherwise half the session lifecycle happens on the developer's server and the
    // isolation above buys nothing. Written directly rather than through `stub` so it
    // does not fill calls.log with every tmux invocation rr.sh makes.
    writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash\nexec /usr/bin/tmux -S ${socket} "$@"\n`, { mode: 0o755 })
    chmodSync(join(bin, "tmux"), 0o755)
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

  afterEach(async () => {
    // Kill any pending detached respawn FIRST. Its whole job is to outlive its caller and
    // recreate this session, so tearing down while one is armed just races it - and loses.
    // Matched on this test's own temp path, so it cannot reach anything else.
    await run("pkill", ["-f", join(dir, ".relayroom/respawn.sh")])
    // Then the whole private server, which is total: no session, pane or pending respawn
    // can outlive it, and nothing is left on the developer's tmux server either way.
    await tmux(["kill-server"])
    hub.close()
    if (savedTmux !== undefined) process.env.TMUX = savedTmux
    rmSync(dir, { recursive: true, force: true })
    // `bin` outlives the test on purpose. A detached respawn that pkill missed - it is
    // spawned via setsid and may not be visible yet when pkill runs - resolves `tmux`
    // through PATH when it finally wakes. With the shim gone it would find the REAL tmux
    // and create its session on the developer's server; with the shim still there it
    // targets the private socket, whose server is already dead, and fails harmlessly.
    // Removing them at the end is cleanup; keeping them during the run is correctness.
    bins.push(bin)
  })

  afterAll(() => {
    for (const b of bins) rmSync(b, { recursive: true, force: true })
  })

  const up = (...flags: string[]) => run("bash", [join(dir, "rr.sh"), "up", ...flags], { cwd: dir, env })
  const makeSession = () => tmux(["new-session", "-d", "-s", session, "sleep 300"])

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
    await tmux(["new-session", "-d", "-s", session, `while [ ! -f ${gate} ]; do sleep 0.05; done; exit ${status}`])
    // Wait for the session to EXIST rather than sleeping at it. A guessed 300ms was the
    // bug: under load `set-window-option` ran before the session was there, failed with
    // "no such window", and the option silently never applied - so the pane died, tmux
    // destroyed the session, and this helper timed out looking for a corpse that could
    // never form. Then verify the option took, because a set that did not apply is the
    // failure being guarded against and it reports success either way.
    for (let i = 0; ; i++) {
      if ((await tmux(["has-session", "-t", `=${session}`])).code === 0) break
      if (i > 100) throw new Error("session never appeared")
      await new Promise((r) => setTimeout(r, 50))
    }
    await tmux(["set-window-option", "-t", `=${session}`, "remain-on-exit", "on"])
    const opt = await tmux(["show-window-options", "-t", `=${session}`, "remain-on-exit"])
    if (!/remain-on-exit on/.test(opt.stdout)) throw new Error(`remain-on-exit did not apply: ${opt.stdout}${opt.stderr}`)
    writeFileSync(gate, "")
    // Wait for the pane to be dead AND for its exit status to be readable. Measured:
    // `pane_dead` flips to 1 before `pane_dead_status` is populated, in 11 of 20 samples -
    // so waiting on `pane_dead` alone is waiting on a proxy, and `up` sampling in that
    // window legitimately reports `status ?` instead of `status 3`. That produced a
    // roughly 1-in-3 flake, which is exactly the kind of red that gets re-run until green.
    for (let i = 0; i < 100; i++) {
      const { stdout } = await tmux(["list-panes", "-t", `=${session}`, "-F", "#{pane_dead} #{pane_dead_status}"])
      const lines = stdout.trim().split("\n")
      if (lines.every((l) => /^1 \S/.test(l.trim()))) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error("pane never became dead with a readable exit status")
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
    await tmux(["kill-session", "-t", `=${session}`])
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

  /**
   * `reconnect` is the in-session caller of the same respawn primitive `up --restart`
   * uses. It runs from inside the session it replaces, so the kill would take its own
   * shell with it mid-command - the work is handed to a detached script that outlives
   * both. Driven here through a real tmux session rather than by calling the function,
   * because "does the caller's shell survive long enough" is the whole question.
   */
  const runInSession = async (cmd: string) => {
    const done = join(dir, "in-session-done")
    // PATH is exported inside the command, not passed with `new-session -e`: a pane takes
    // its PATH from the tmux SERVER's environment, and `-e` was measured not to override
    // it (tmux 3.4). Without this the in-session run reaches the real `claude` and
    // `relayroom` instead of the stubs - a test passing against the machine, not the
    // fixture, which is the failure this suite has already shipped once.
    await tmux([
      "new-session", "-d", "-s", session,
      `export PATH=${env.PATH}; ${cmd} > ${join(dir, "in-session.out")} 2>&1; touch ${done}; sleep 120`,
    ])
    for (let i = 0; i < 120; i++) {
      if (existsSync(done)) return readFileSync(join(dir, "in-session.out"), "utf8")
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`in-session command never finished: ${readFileSync(join(dir, "in-session.out"), "utf8")}`)
  }

  it("reconnect replaces the session from inside it, without killing its own shell", async () => {
    const out = await runInSession(`bash ${join(dir, "rr.sh")} reconnect`)
    // The command returned, which is the point: the shell outlived its own kill order.
    expect(out).toContain("will be replaced as soon as this command returns")
    expect(out).toContain("detached")
    // And the replacement actually happens, after the caller exits.
    for (let i = 0; i < 100; i++) {
      const state = existsSync(join(dir, ".relayroom", "last-respawn"))
        ? readFileSync(join(dir, ".relayroom", "last-respawn"), "utf8")
        : ""
      if (state.includes(" ok ")) {
        expect((await tmux(["has-session", "-t", `=${session}`])).code).toBe(0)
        return
      }
      if (state.includes(" failed ")) throw new Error(`respawn failed: ${state}`)
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error("detached respawn never recorded an outcome")
  })

  /**
   * The asymmetry that made detection safe enough to prefer over a flag: detached works
   * from either caller, in-place only from outside. So a detection that CANNOT answer
   * must resolve to detached - the cost is a slower restart instead of a shell killed
   * mid-command. Simulated by making `tmux display` return nothing while `$TMUX` is set,
   * which is what a detection failure looks like from inside the script.
   */
  it("falls back to the detached path when it cannot tell which session it is in", async () => {
    // A tmux stub that answers everything except `display`, so the check goes blank.
    // Same private server as the shim it replaces - otherwise this one test would talk to
    // the developer's tmux and its session would outlive the run.
    stub("tmux", `if [ "\${1:-}" = "display" ]; then exit 0; fi\nexec /usr/bin/tmux -S ${socket} "$@"`)
    const out = await runInSession(`bash ${join(dir, "rr.sh")} reconnect`)
    expect(out).toContain("will be replaced as soon as this command returns")
    expect(out).not.toContain("restarting session")
  })

  it("reconnect re-registers before replacing the session", async () => {
    await runInSession(`bash ${join(dir, "rr.sh")} reconnect`)
    expect(calls()).toMatch(/claude mcp add -s project/)
  })

  /**
   * A detached respawn outlives the process that asked for it, so a failure has nobody
   * left to report it - the agent's session is gone and the owner sees only silence.
   * `up` and `status` read the recorded outcome so the silence explains itself.
   */
  it("status reports a failed respawn instead of leaving the silence unexplained", async () => {
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(join(dir, ".relayroom", "last-respawn"), `${Math.floor(Date.now() / 1000)} failed tmux-refused-new-session\n`)
    const { stdout, stderr } = await run("bash", [join(dir, "rr.sh"), "status"], { cwd: dir, env })
    expect(stdout + stderr).toContain("last session respawn FAILED")
    expect(stdout + stderr).toContain("tmux-refused-new-session")
  })

  it("status says nothing about a respawn that succeeded", async () => {
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(join(dir, ".relayroom", "last-respawn"), `${Math.floor(Date.now() / 1000)} ok respawned-detached\n`)
    const { stdout, stderr } = await run("bash", [join(dir, "rr.sh"), "status"], { cwd: dir, env })
    expect(stdout + stderr).not.toContain("FAILED")
  })

  it("up reports a failed respawn once, then clears it", async () => {
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(join(dir, ".relayroom", "last-respawn"), `${Math.floor(Date.now() / 1000)} failed tmux-refused-new-session\n`)
    const first = await up()
    expect(first.stdout + first.stderr).toContain("last session respawn FAILED")
    // A session exists again, so the failure is answered rather than reported forever.
    const second = await up()
    expect(second.stdout + second.stderr).not.toContain("FAILED")
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
    await tmux(["set-window-option", "-t", `=${session}`, "remain-on-exit", "on"])
    const { stdout } = await up()
    expect(stdout).not.toContain("is a corpse")
    expect(stdout).not.toContain("restarting session")
  })
})
