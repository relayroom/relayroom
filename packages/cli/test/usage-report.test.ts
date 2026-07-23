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
function usageCollector(): { server: Server; port: Promise<number>; received: () => any | null } {
  let body: any = null
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      try { body = { url: req.url, json: JSON.parse(raw) } } catch { body = { url: req.url, json: null } }
      res.writeHead(200, { "content-type": "application/json" })
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
