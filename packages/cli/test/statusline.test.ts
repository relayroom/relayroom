import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { STATUSLINE_MARKER, statusLineUpdate, userStatuslinePath } from "../src/hooks"
import { init } from "../src/init"
import { SUBPROCESS_TIMEOUT_MS } from "./timeouts"

/**
 * The in-pane status bar. A herdr pane has no tmux bar, and Claude Code's statusLine is
 * the replacement with a property the workspace token cannot have: it is POLLED, so the
 * checker is a different process from the thing it checks and a dead pager turns the bar
 * red by itself, rather than freezing on the last thing a live process managed to push.
 *
 * The composition tests are the important half. A user's statusLine is their
 * configuration, and replacing it silently is the settings-file version of the
 * session-rename bug this same stack already paid for.
 */
describe("statusLine install composes rather than replaces", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-sl-"))
    // A generated rr.sh that can render the bar. The installer reads the file for the
    // capability rather than trusting its own version, so the fixture has to carry it.
    writeFileSync(join(dir, "rr.sh"), "#!/usr/bin/env bash\nsl_claude() { :; }\n")
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("installs into an empty settings file", () => {
    const settings: Record<string, unknown> = {}
    expect(statusLineUpdate(settings, dir, join(dir, "no-user.json"))).toEqual({ action: "installed", wrapped: undefined })
    expect((settings.statusLine as { command: string }).command).toContain(STATUSLINE_MARKER)
    // Nothing was parked, because there was nothing to park.
    expect(existsSync(userStatuslinePath(dir))).toBe(false)
  })

  it("parks a user's command instead of losing it", () => {
    const settings: Record<string, unknown> = {
      statusLine: { type: "command", command: "~/bin/my-bar.sh --fancy" },
    }
    const res = statusLineUpdate(settings, dir, join(dir, "no-user.json"))
    expect(res.action).toBe("composed")
    expect(res.wrapped).toBe("~/bin/my-bar.sh --fancy")
    expect(readFileSync(userStatuslinePath(dir), "utf8").trim()).toBe("~/bin/my-bar.sh --fancy")
    expect((settings.statusLine as { command: string }).command).toContain(STATUSLINE_MARKER)
  })

  it("refuses to point at an rr.sh that cannot render it", () => {
    // The failure this prevents is not an error: an older rr.sh falls THROUGH to the
    // tmux renderer, so the bar fills with raw `#[fg=colour240]` markup and nothing
    // reports a problem. Measured on a live worktree before this guard existed.
    const stale = mkdtempSync(join(tmpdir(), "relayroom-slold-"))
    writeFileSync(join(stale, "rr.sh"), "#!/usr/bin/env bash\nsl() { :; }\n")
    const settings: Record<string, unknown> = {}
    const res = statusLineUpdate(settings, stale, join(stale, "no-user.json"))
    expect(res.action).toBe("skipped")
    expect(res.why).toMatch(/--claude/)
    // And it left the settings alone rather than writing a command that renders garbage.
    expect(settings.statusLine).toBeUndefined()
    rmSync(stale, { recursive: true, force: true })
  })

  it("composes with a USER-level statusLine when the project file has none", () => {
    // The one that nearly shipped wrong. Claude Code merges settings with the project
    // file winning, and people configure their bar once in ~/.claude/settings.json - so
    // an empty `statusLine` in the project file does NOT mean the slot is free. Measured
    // on the machine this was written on: the user had a global bar and the project file
    // had no statusLine at all.
    const userSettings = join(dir, "user-settings.json")
    writeFileSync(userSettings, JSON.stringify({ statusLine: { type: "command", command: "bash ~/.claude/mybar.sh" } }))
    const settings: Record<string, unknown> = {}
    const res = statusLineUpdate(settings, dir, userSettings)
    expect(res.action).toBe("composed")
    expect(res.wrapped).toBe("bash ~/.claude/mybar.sh")
    expect(readFileSync(userStatuslinePath(dir), "utf8").trim()).toBe("bash ~/.claude/mybar.sh")
  })

  it("a missing or unreadable user settings file is simply nothing to compose with", () => {
    const settings: Record<string, unknown> = {}
    expect(statusLineUpdate(settings, dir, join(dir, "does-not-exist.json")).action).toBe("installed")
    const broken = join(dir, "broken.json")
    writeFileSync(broken, "{ not json")
    expect(statusLineUpdate({}, dir, broken).action).toBe("installed")
  })

  it("re-installing does not wrap our own wrapper", () => {
    const settings: Record<string, unknown> = {}
    statusLineUpdate(settings, dir, join(dir, "no-user.json"))
    const first = JSON.stringify(settings.statusLine)
    // The bug this prevents: each install parks the previous command, so ours would
    // become "the user's" and the chain would grow a layer every time setup runs.
    expect(statusLineUpdate(settings, dir, join(dir, "no-user.json"))).toEqual({ action: "unchanged" })
    expect(JSON.stringify(settings.statusLine)).toBe(first)
    expect(existsSync(userStatuslinePath(dir))).toBe(false)
  })

  it("keeps the user's command parked across a re-install", () => {
    const settings: Record<string, unknown> = { statusLine: { type: "command", command: "mine.sh" } }
    statusLineUpdate(settings, dir, join(dir, "no-user.json"))
    statusLineUpdate(settings, dir, join(dir, "no-user.json"))
    expect(readFileSync(userStatuslinePath(dir), "utf8").trim()).toBe("mine.sh")
  })
})

/**
 * And the rendering half, against the REAL generated script: what Claude Code actually
 * runs, with the JSON it actually pipes in.
 */
describe("rr.sh statusline --claude", () => {
  let dir: string
  let hub: Server
  let hubUrl: string

  const render = (stdin: string) =>
    new Promise<string>((resolve) => {
      const child = execFile("bash", [join(dir, "rr.sh"), "statusline", "--claude"],
        { cwd: dir, timeout: SUBPROCESS_TIMEOUT_MS }, (_e, stdout) => resolve(String(stdout)))
      child.stdin?.end(stdin)
    })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-slr-"))
    hub = createServer((req, res) => {
      if (String(req.url).includes("/unread")) {
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ count: 3 })); return
      }
      res.writeHead(200, { "content-type": "text/markdown", "x-relayroom-project-slug": "demo" })
      res.end("# RELAYROOM.md\n")
    })
    hubUrl = await new Promise<string>((r) => {
      hub.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(hub.address() as { port: number }).port}`))
    })
    await init({ dir, code: "c1", part: "barpart", server: hubUrl, token: "tok", tmuxCheck: false, target: "RR-bar" })
  })
  afterEach(async () => {
    await new Promise<void>((r) => hub.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it("renders the part, the unread count and the two health dots", async () => {
    const out = await render("{}")
    expect(out).toContain("barpart")
    expect(out).toContain("inbox 3")
    expect(out).toContain("MCP")
    // The pager is not running in this temp worktree, and the bar must SAY so rather
    // than omit it - a missing indicator reads as a fine one.
    expect(out).toMatch(/!Pager/)
    expect(out.trim().split("\n").length).toBe(1)
  })

  it("runs the user's command first and gives it the same stdin", async () => {
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    // Echoes what it was given, so the test can prove the JSON was passed through and
    // not eaten by the wrapper.
    writeFileSync(join(dir, ".relayroom", "statusline.user"), `sed -n 's/.*"model":"\\([a-z0-9-]*\\)".*/model \\1/p'\n`)
    const out = await render('{"model":"opus-5"}')
    expect(out).toContain("model opus-5")
    expect(out).toContain("barpart")
    // One line: Claude Code renders the first line, and a wrapper that emitted two
    // would silently drop half of what it composed.
    expect(out.trim().split("\n").length).toBe(1)
  })

  it("a user command that fails does not take the RelayRoom segment down with it", async () => {
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(join(dir, ".relayroom", "statusline.user"), "exit 7\n")
    const out = await render("{}")
    expect(out).toContain("barpart")
    expect(out).toContain("inbox 3")
  })
})
