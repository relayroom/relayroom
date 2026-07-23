import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { hookCommand } from "../src/hooks"

const REPORTER = fileURLToPath(new URL("../runtime/usage-report.mjs", import.meta.url))

/** A minimal Claude transcript: one user turn, one assistant reply with usage. */
const TRANSCRIPT = [
  JSON.stringify({ type: "user", timestamp: "2026-07-23T00:00:00Z", message: { content: "hi" } }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-23T00:00:05Z",
    message: {
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
    },
  }),
].join("\n")

/** Collect one POSTed usage body, or null if the reporter never called. */
function usageCollector(status = 200): { server: Server; port: Promise<number>; received: () => any | null } {
  let body: any = null
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      try {
        body = { url: req.url, json: JSON.parse(raw), auth: req.headers.authorization }
      } catch {
        body = { url: req.url, json: null, auth: req.headers.authorization }
      }
      res.writeHead(status, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  const port = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))
  })
  return { server, port, received: () => body }
}

/** Run the reporter the way an agent fires it: argv + a JSON payload on stdin. */
function runReporter(args: string[], payload: unknown, cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [REPORTER, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    child.stdout.resume()
    child.stdin.end(JSON.stringify(payload))
    child.on("exit", (code) => resolve({ code: code ?? 0, stderr }))
  })
}

describe("usage reporter: identity resolution", () => {
  let dir: string
  let elsewhere: string
  let collector: ReturnType<typeof usageCollector>
  let server: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-usage-"))
    elsewhere = mkdtempSync(join(tmpdir(), "relayroom-elsewhere-"))
    collector = usageCollector()
    server = `http://127.0.0.1:${await collector.port}`
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(
      join(dir, ".relayroom", "config.json"),
      JSON.stringify({ code: "code-from-config", part: "core", server }),
    )
    writeFileSync(join(dir, "transcript.jsonl"), TRANSCRIPT)
  })

  afterEach(() => {
    collector.server.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  it("resolves code/part from the worktree config when the command carries no secret", async () => {
    await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    const got = collector.received()
    expect(got?.url).toBe("/mcp/code-from-config/usage")
    expect(got?.json.part).toBe("core")
    expect(got?.json.usage).toMatchObject({ input_tokens: 10, output_tokens: 20, cache_tokens: 5 })
  })

  it("uses the payload's cwd, not the process cwd (Codex hooks.json is machine-global)", async () => {
    // Fired from an unrelated directory - the turn's own cwd is what identifies it.
    const { stderr } = await runReporter(
      ["--agent", "claude"],
      { transcript_path: join(dir, "transcript.jsonl"), cwd: dir },
      elsewhere,
    )
    expect(stderr).toBe("")
    expect(collector.received()?.json.part).toBe("core")
  })

  it("still honors an explicit --code/--part (hooks installed by an older CLI)", async () => {
    await runReporter(
      ["--agent", "claude", "--code", "explicit", "--part", "legacy", "--server", server],
      { transcript_path: join(dir, "transcript.jsonl") },
      dir,
    )
    const got = collector.received()
    expect(got?.url).toBe("/mcp/explicit/usage")
    expect(got?.json.part).toBe("legacy")
  })

  it("reports nothing and says why when no worktree config can be found", async () => {
    const { code, stderr } = await runReporter(
      ["--agent", "claude"],
      { transcript_path: join(dir, "transcript.jsonl") },
      elsewhere,
    )
    expect(code).toBe(0) // never blocks the agent
    expect(stderr).toContain("no connect code/part")
    expect(collector.received()).toBeNull()
  })
})

describe("usage reporter: content excerpts", () => {
  let dir: string
  let collector: ReturnType<typeof usageCollector>
  let server: string

  const writeConfig = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, ".relayroom", "config.json"),
      JSON.stringify({ code: "c", part: "core", server, ...extra }),
    )

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-usage-content-"))
    collector = usageCollector()
    server = `http://127.0.0.1:${await collector.port}`
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeConfig()
    writeFileSync(join(dir, "transcript.jsonl"), TRANSCRIPT)
  })

  afterEach(() => {
    collector.server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("includes the prompt/answer excerpts by default (the dashboard event shows the exchange)", async () => {
    await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    expect(collector.received()?.json.detail).toEqual({ title: "hi", summary: "hello" })
  })

  it("drops them when the worktree config opts out, keeping the token counts", async () => {
    writeConfig({ usageContent: false })
    await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    const got = collector.received()
    expect(got?.json.detail).toBeUndefined()
    expect(got?.json.usage.input_tokens).toBe(10)
  })

  it("keeps reporting when the config opts back in", async () => {
    writeConfig({ usageContent: true })
    await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    expect(collector.received()?.json.detail).toEqual({ title: "hi", summary: "hello" })
  })
})

describe("usage reporter: bearer", () => {
  let dir: string
  let collector: ReturnType<typeof usageCollector>
  let server: string

  const writeConfig = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, ".relayroom", "config.json"),
      JSON.stringify({ code: "c", part: "core", server, ...extra }),
    )

  const setup = async (status = 200) => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-usage-auth-"))
    collector = usageCollector(status)
    server = `http://127.0.0.1:${await collector.port}`
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(join(dir, "transcript.jsonl"), TRANSCRIPT)
  }

  afterEach(() => {
    collector.server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("sends the worktree's token", async () => {
    await setup()
    writeConfig({ token: "tok-abc" })
    await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    expect(collector.received()?.auth).toBe("Bearer tok-abc")
  })

  it("sends NO authorization header when the worktree has no token", async () => {
    await setup()
    writeConfig()
    // The endpoint accepts an unauthenticated report during the grace period, and an
    // empty `Bearer ` would be a present-but-invalid credential the server rejects.
    const { code } = await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    expect(code).toBe(0)
    expect(collector.received()?.auth).toBeUndefined()
    expect(collector.received()?.json.part).toBe("core")
  })

  it("reports a rejected POST on stderr instead of exiting quietly", async () => {
    await setup(401)
    writeConfig({ token: "stale" })
    const { code, stderr } = await runReporter(
      ["--agent", "claude"],
      { transcript_path: join(dir, "transcript.jsonl") },
      dir,
    )
    expect(code).toBe(0) // never blocks the agent
    expect(stderr).toContain("401")
    expect(stderr).toContain("./rr.sh setup")
  })
})

describe("usage reporter: cost estimate", () => {
  let dir: string
  let collector: ReturnType<typeof usageCollector>
  let server: string

  // A cache-heavy turn - the normal shape for an agent, and where charging cache
  // tokens at the full input rate goes badly wrong.
  const CACHED_TRANSCRIPT = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hello" }],
        usage: {
          input_tokens: 500,
          output_tokens: 300,
          cache_creation_input_tokens: 1_000,
          cache_read_input_tokens: 100_000,
        },
      },
    }),
  ].join("\n")

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relayroom-usage-cost-"))
    collector = usageCollector()
    server = `http://127.0.0.1:${await collector.port}`
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
    writeFileSync(join(dir, ".relayroom", "config.json"), JSON.stringify({ code: "c", part: "core", server }))
    writeFileSync(join(dir, "transcript.jsonl"), CACHED_TRANSCRIPT)
  })

  afterEach(() => {
    collector.server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("bills cache reads at 0.1x and cache writes at 1.25x the input rate", async () => {
    await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    const got = collector.received()
    const [inRate, outRate] = [5, 25] // the verified Opus 4.8 rate
    const expected =
      (500 / 1e6) * inRate +
      (1_000 / 1e6) * inRate * 1.25 +
      (100_000 / 1e6) * inRate * 0.1 +
      (300 / 1e6) * outRate
    expect(got?.json.usage.cost_usd).toBeCloseTo(expected, 6)
    // The old formula charged every cache token at the full input rate; on this
    // turn that is off by roughly 8x.
    const atFullRate = ((500 + 101_000) / 1e6) * inRate + (300 / 1e6) * outRate
    expect(got?.json.usage.cost_usd).toBeLessThan(atFullRate / 5)
  })

  it("still reports one cache_tokens total (the wire format is unchanged)", async () => {
    await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    expect(collector.received()?.json.usage.cache_tokens).toBe(101_000)
  })

  /** Same turn shape, a different model id. */
  const transcriptFor = (model: string) =>
    [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          model,
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      }),
    ].join("\n")

  const costFor = async (model: string) => {
    writeFileSync(join(dir, "transcript.jsonl"), transcriptFor(model))
    await runReporter(["--agent", "claude"], { transcript_path: join(dir, "transcript.jsonl") }, dir)
    return collector.received()?.json.usage
  }

  it("prices the current Opus generation at its own rate, not the 4.1 one", async () => {
    // 1M input tokens, so the reported cost IS the input rate.
    expect((await costFor("claude-opus-4-8")).cost_usd).toBeCloseTo(5, 6)
  })

  it("resolves dated snapshots and context-tagged ids to the base model's rate", async () => {
    expect((await costFor("claude-haiku-4-5-20251001")).cost_usd).toBeCloseTo(1, 6)
    expect((await costFor("claude-opus-4-8[1m]")).cost_usd).toBeCloseTo(5, 6)
  })

  it("omits the cost entirely for a model with no verified rate, keeping the tokens", async () => {
    // Opus 4.1 is deliberately unlisted: reporting nothing beats reporting a guess.
    const usage = await costFor("claude-opus-4-1-20250805")
    expect(usage.cost_usd).toBeUndefined()
    expect(usage.input_tokens).toBe(1_000_000)
  })
})

describe("usage hook command", () => {
  it("never writes the connect code into the agent settings file", () => {
    const cmd = hookCommand({
      agent: "claude",
      code: "s3cr3t-connect-code",
      part: "core",
      server: "http://localhost:48801",
    })
    expect(cmd).not.toContain("s3cr3t-connect-code")
    expect(cmd).not.toContain("--code")
  })
})
