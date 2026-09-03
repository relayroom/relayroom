import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { init, pagersTargeting } from "../src/init"
import { SUBPROCESS_TIMEOUT_MS } from "./timeouts"

/**
 * `init` renames the tmux session it is run inside to this part's standard name. The
 * assumption underneath - "the session init runs in belongs to the part init is for" -
 * is false the moment someone runs init for a scratch part from inside a live part's
 * session, and it cost a real outage on this machine: a stage-3 scratch init renamed a
 * working part's session, and that part's pager - which addresses its agent BY SESSION
 * NAME - kept running, kept its SSE connection, reported healthy, and delivered nothing
 * until a human noticed the silence.
 *
 * These tests pin the refusal and, in both directions, the cases where renaming is still
 * right. The claimant is a REAL process in the process table, because the check reads
 * `ps`: a stubbed listing would agree with any implementation, including one that never
 * looks.
 */
describe("init does not rename a tmux session another part's pager is addressing", () => {
  let dir: string
  let bin: string
  let socket: string
  let hub: Server
  let hubUrl: string
  let savedPath: string | undefined
  let savedTmux: string | undefined
  const kids: ChildProcess[] = []

  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve) => {
      execFile(cmd, args, { timeout: SUBPROCESS_TIMEOUT_MS }, (_e, stdout) => resolve(String(stdout)))
    })
  const tmux = (args: string[]) => run("/usr/bin/tmux", ["-S", socket, ...args])
  const sessions = async () => (await tmux(["list-sessions", "-F", "#S"])).trim().split("\n").filter(Boolean)

  /** A live process whose command line looks like a pager for `part` on `target`. */
  const fakePager = (part: string, target: string) => {
    const script = join(bin, "relayroom-pager.mjs")
    writeFileSync(script, "setTimeout(() => {}, 120000)\n")
    const child = spawn(process.execPath, [script, "--code", "c1", "--part", part, "--server", "http://x", "--target", target], {
      stdio: "ignore",
    })
    kids.push(child)
    return child
  }

  /** Wait until `ps` actually shows the pager - spawn returns before it is listed. */
  const untilListed = async (target: string) => {
    for (let i = 0; i < 50; i++) {
      if (pagersTargeting(target).length > 0) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-rename-"))
    bin = mkdtempSync(join(tmpdir(), "relayroom-renamebin-"))
    socket = join(bin, "tmux.sock")
    // init calls execFileSync("tmux", ...) in THIS process, so the shim has to be on
    // this process's PATH, not a child env. Restored in afterEach.
    writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash\nexec /usr/bin/tmux -S ${socket} "$@"\n`, { mode: 0o755 })
    chmodSync(join(bin, "tmux"), 0o755)
    savedPath = process.env.PATH
    savedTmux = process.env.TMUX
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
    process.env.TMUX = "/fake/tmux-socket,1,0"
    hub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown", "x-relayroom-project-slug": "demo" })
      res.end("# RELAYROOM.md\n")
    })
    hubUrl = await new Promise<string>((resolve) => {
      hub.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(hub.address() as { port: number }).port}`))
    })
  })

  afterEach(async () => {
    for (const k of kids) k.kill("SIGKILL")
    kids.length = 0
    await tmux(["kill-server"])
    await new Promise<void>((r) => hub.close(() => r()))
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedTmux === undefined) delete process.env.TMUX
    else process.env.TMUX = savedTmux
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("reads the live process table, not a config: only a pager on THAT target counts", async () => {
    const victim = `RR-victim-${process.pid}`
    fakePager("other", victim)
    expect(await untilListed(victim)).toBe(true)
    expect(pagersTargeting(victim).map((p) => p.part)).toEqual(["other"])
    // Negative control: a name no pager holds must come back empty, or the refusal
    // below would fire for every rename and prove nothing.
    expect(pagersTargeting(`${victim}-nobody`)).toEqual([])
  })

  it("refuses the rename and says whose pager would go silent", async () => {
    const victim = `RR-victim-${process.pid}`
    await tmux(["new-session", "-d", "-s", victim])
    fakePager("other", victim)
    expect(await untilListed(victim)).toBe(true)

    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await init({ dir, code: "c1", part: "mine", server: hubUrl, token: "tok", tmuxCheck: false, target: "RR-demo-mine" })
    const said = log.mock.calls.map((c) => c.join(" ")).join("\n")

    expect(await sessions()).toContain(victim)
    expect(await sessions()).not.toContain("RR-demo-mine")
    expect(said).toMatch(/NOT renaming tmux session/)
    // The refusal has to carry the evidence - which part, which pid - or the person
    // reading it cannot tell whether it was right.
    expect(said).toMatch(/other \(pid \d+\)/)
  })

  it("still renames when nothing is listening on the old name", async () => {
    const plain = `RR-plain-${process.pid}`
    await tmux(["new-session", "-d", "-s", plain])
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await init({ dir, code: "c1", part: "mine", server: hubUrl, token: "tok", tmuxCheck: false, target: "RR-demo-mine" })
    const said = log.mock.calls.map((c) => c.join(" ")).join("\n")

    expect(await sessions()).toContain("RR-demo-mine")
    expect(said).toMatch(/renamed tmux session/)
    expect(said).not.toMatch(/NOT renaming/)
  })

  it("renames for its OWN pager but says the pager is now addressing a dead name", async () => {
    const mineOld = `RR-old-${process.pid}`
    await tmux(["new-session", "-d", "-s", mineOld])
    fakePager("mine", mineOld)
    expect(await untilListed(mineOld)).toBe(true)

    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await init({ dir, code: "c1", part: "mine", server: hubUrl, token: "tok", tmuxCheck: false, target: "RR-demo-mine" })
    const said = log.mock.calls.map((c) => c.join(" ")).join("\n")

    expect(await sessions()).toContain("RR-demo-mine")
    expect(said).toMatch(/renamed tmux session/)
    expect(said).toMatch(/pager restart/)
  })
})
