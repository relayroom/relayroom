import { createServer, type Server } from "node:http"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { init } from "../src/init"

/**
 * `init` used to demand tmux from everyone, and the only way past it was
 * `--no-tmux-check` - a flag that reads as "switch a safety check off". On a machine
 * with no tmux installed at all, which is the normal shape of a herdr setup, the
 * documented order (`init`, then `up --use-herdr`) could not be followed: the multiplexer
 * field is written by `up`, which runs after the thing that refuses to run.
 *
 * Reported by a real user on macOS. They worked around the refusal, and the workaround
 * left a stale config behind that launched a different agent than the one they had just
 * asked for - which is the second guard here.
 */
describe("init on a herdr machine", () => {
  let dir: string
  let hub: Server
  let hubUrl: string
  let savedTmux: string | undefined
  let errors: string[]
  let exits: number[]

  /** init exits the process on a refusal, so the test observes that rather than
   *  letting it kill the runner. The real code path is unchanged. */
  const runInit = async (opts: Record<string, unknown>) => {
    try {
      await init({ dir, server: hubUrl, ...opts })
    } catch (err) {
      if ((err as Error).message !== "process.exit") throw err
    }
    return { errors: errors.join("\n"), exits }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-initmux-"))
    savedTmux = process.env.TMUX
    delete process.env.TMUX
    errors = []
    exits = []
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")) })
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code ?? 0)
      throw new Error("process.exit")
    }) as never)
    hub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown", "x-relayroom-project-slug": "demo" })
      res.end("# RELAYROOM.md\n")
    })
    hubUrl = await new Promise<string>((r) => {
      hub.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(hub.address() as { port: number }).port}`))
    })
  })

  afterEach(async () => {
    await new Promise<void>((r) => hub.close(() => r()))
    if (savedTmux === undefined) delete process.env.TMUX
    else process.env.TMUX = savedTmux
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const config = () => JSON.parse(readFileSync(join(dir, ".relayroom", "config.json"), "utf8"))
  const seedConfig = (c: Record<string, unknown>) => {
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(join(dir, ".relayroom", "config.json"), JSON.stringify(c, null, 2))
  }

  it("still refuses outside tmux when nothing says herdr", async () => {
    const { errors: out, exits: codes } = await runInit({ code: "c1", part: "acti-bong" })
    expect(codes).toEqual([1])
    // The refusal has to offer the herdr path, or the only visible way forward is a flag
    // that sounds like disabling a check.
    expect(out).toMatch(/--multiplexer herdr/)
    expect(out).toMatch(/tmux new -s relayroom-acti-bong/)
  })

  it("proceeds with no tmux anywhere when the worktree says herdr", async () => {
    const { exits: codes } = await runInit({ code: "c1", part: "acti-bong", agent: "claude", multiplexer: "herdr" })
    expect(codes).toEqual([])
    expect(config().multiplexer).toBe("herdr")
    expect(config().part).toBe("acti-bong")
  })

  it("does not block a re-init in a worktree already on herdr", async () => {
    seedConfig({ code: "c1", part: "acti-bong", multiplexer: "herdr", server: hubUrl })
    // The documented way to re-pull RELAYROOM.md is a bare `relayroom init`, and on a
    // herdr machine there is still no tmux to be inside.
    const { exits: codes } = await runInit({})
    expect(codes).toEqual([])
  })

  it("still refuses when the saved multiplexer is tmux", async () => {
    // Negative control: reading the config must not become a blanket bypass. A tmux
    // worktree outside tmux is exactly the case the guard exists for.
    seedConfig({ code: "c1", part: "p", multiplexer: "tmux", server: hubUrl })
    const { exits: codes } = await runInit({})
    expect(codes).toEqual([1])
  })

  it("writes no multiplexer when none was asked for", async () => {
    // Absent and "tmux" read the same at every call site but are different facts, and
    // stamping a choice on a worktree that never made one loses the distinction. Run
    // inside tmux, because this is about what gets WRITTEN, not about the guard.
    process.env.TMUX = "/fake,1,0"
    await runInit({ code: "c1", part: "p" })
    expect(config().multiplexer).toBeUndefined()
    expect(config().part).toBe("p")
  })
})

describe("init refuses to re-point a worktree behind your back", () => {
  let dir: string
  let hub: Server
  let hubUrl: string
  let errors: string[]
  let exits: number[]
  let savedTmux: string | undefined

  const runInit = async (opts: Record<string, unknown>) => {
    try {
      await init({ dir, server: hubUrl, ...opts })
    } catch (err) {
      if ((err as Error).message !== "process.exit") throw err
    }
    return { errors: errors.join("\n"), exits }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-initid-"))
    savedTmux = process.env.TMUX
    process.env.TMUX = "/fake,1,0"
    errors = []
    exits = []
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")) })
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code ?? 0)
      throw new Error("process.exit")
    }) as never)
    hub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown", "x-relayroom-project-slug": "demo" })
      res.end("# RELAYROOM.md\n")
    })
    hubUrl = await new Promise<string>((r) => {
      hub.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(hub.address() as { port: number }).port}`))
    })
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(join(dir, ".relayroom", "config.json"),
      JSON.stringify({ code: "c1", part: "sha-codex", agent: "codex", server: hubUrl }, null, 2))
  })

  afterEach(async () => {
    await new Promise<void>((r) => hub.close(() => r()))
    if (savedTmux === undefined) delete process.env.TMUX
    else process.env.TMUX = savedTmux
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const config = () => JSON.parse(readFileSync(join(dir, ".relayroom", "config.json"), "utf8"))

  it("names both values and the way through", async () => {
    const { errors: out, exits: codes } = await runInit({ part: "acti-bong", agent: "claude" })
    expect(codes).toEqual([1])
    expect(out).toMatch(/part: sha-codex -> acti-bong/)
    expect(out).toMatch(/agent: codex -> claude/)
    expect(out).toMatch(/--force/)
    // Refused means nothing changed - a guard that rejects after writing is not a guard.
    expect(config().part).toBe("sha-codex")
  })

  it("--force re-points it", async () => {
    const { exits: codes } = await runInit({ part: "acti-bong", agent: "claude", force: true })
    expect(codes).toEqual([])
    expect(config().part).toBe("acti-bong")
    expect(config().agent).toBe("claude")
  })

  it("an omitted flag still means reuse, not conflict", async () => {
    // The bare re-init is the documented way to re-pull RELAYROOM.md; only an EXPLICIT
    // disagreement is a conflict.
    const { exits: codes } = await runInit({})
    expect(codes).toEqual([])
    expect(config().part).toBe("sha-codex")
  })

  it("the same value passed explicitly is not a conflict", async () => {
    const { exits: codes } = await runInit({ part: "sha-codex", agent: "codex" })
    expect(codes).toEqual([])
  })
})
