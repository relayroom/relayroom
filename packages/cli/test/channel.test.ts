import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ensureChannelMcp } from "../src/init"
import pkg from "../package.json"

const CHANNEL = fileURLToPath(new URL("../runtime/relayroom-channel.mjs", import.meta.url))

/**
 * Drive the channel server as Claude would: spawn it, write newline-delimited
 * JSON-RPC to stdin, collect stdout (the MCP transport) and stderr (logs). Resolves
 * after `waitMs`, then kills the process. Default server URL is dead (SSE harmless);
 * pass `server` to point it at a mock.
 */
function runChannel(
  args: string[],
  input: string,
  waitMs = 400,
  server = "http://127.0.0.1:9",
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CHANNEL, ...args, "--server", server], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.stdin.write(input)
    setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ stdout, stderr })
    }, waitMs)
  })
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
})
const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })

/** Parse the JSON-RPC responses the server wrote to stdout (one per line). */
function rpcResponses(stdout: string): any[] {
  return stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

describe("channel server: MCP handshake", () => {
  it("advertises the claude/channel capability and echoes the protocol version", async () => {
    const { stdout } = await runChannel(["--code", "c1", "--part", "pm"], INIT + "\n")
    const res = rpcResponses(stdout).find((m) => m.id === 0)
    expect(res).toBeTruthy()
    expect(res.result.protocolVersion).toBe("2025-06-18")
    expect(res.result.capabilities.experimental).toHaveProperty("claude/channel")
    expect(res.result.serverInfo.name).toBe("relayroom-channel")
    // The handshake must report the shipped version, not a literal that nothing bumps.
    expect(res.result.serverInfo.version).toBe(pkg.version)
  })

  it("answers ping with an empty result and unknown requests with method-not-found", async () => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    const tools = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const { stdout } = await runChannel(["--code", "c1", "--part", "pm"], [INIT, ping, tools].join("\n") + "\n")
    const out = rpcResponses(stdout)
    expect(out.find((m) => m.id === 1).result).toEqual({})
    expect(out.find((m) => m.id === 2).error.code).toBe(-32601)
  })

  it("never writes logs to stdout (stdout is the MCP transport)", async () => {
    const { stdout } = await runChannel(["--code", "c1", "--part", "pm", "--delivery", "channel"], INIT + "\n" + INITIALIZED + "\n")
    // Every stdout line must be a valid JSON-RPC message, never a `[channel ...]` log.
    for (const line of stdout.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow()
      expect(line).not.toContain("[channel")
    }
  })
})

describe("channel server: delivery gating", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-channel-"))
    mkdirSync(join(dir, ".relayroom"), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function writeConfig(delivery: "channel" | "pager") {
    writeFileSync(
      join(dir, ".relayroom", "config.json"),
      JSON.stringify({ code: "c1", part: "pm", delivery }),
    )
  }

  it("runs the wake pipeline when delivery=channel", async () => {
    writeConfig("channel")
    const { stderr } = await runChannel(["--dir", dir], INIT + "\n" + INITIALIZED + "\n")
    expect(stderr).toContain("channel ready")
    expect(stderr).not.toContain("dormant")
  })

  it("stays dormant (no pipeline) when delivery=pager", async () => {
    writeConfig("pager")
    const { stderr } = await runChannel(["--dir", dir], INIT + "\n" + INITIALIZED + "\n")
    expect(stderr).toContain("dormant")
    expect(stderr).not.toContain("channel ready")
  })

  it("does not start the pipeline before notifications/initialized", async () => {
    writeConfig("channel")
    // Send initialize only - no `initialized`. The pipeline must not start yet.
    const { stderr } = await runChannel(["--dir", dir], INIT + "\n")
    expect(stderr).not.toContain("channel ready")
  })
})

describe("channel server: end-to-end wake delivery", () => {
  let server: Server
  let url: string
  const delivered: Array<{ wakeId: unknown; holder: unknown }> = []
  let claimMode: "ok" | "fail500" = "ok"

  beforeEach(async () => {
    delivered.length = 0
    claimMode = "ok"
    server = createServer((req, res) => {
      const u = req.url ?? ""
      if (u.startsWith("/api/sse")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        // A presence event (kind:'pager') shares this stream and must be IGNORED,
        // then one real message event for part "pm". Hold the stream open after.
        res.write(`data: ${JSON.stringify({ kind: "pager", part: "pm", online: true })}\n\n`)
        res.write(`data: ${JSON.stringify({ kind: "message", part: "pm", subject: "hi", fromPart: "alice" })}\n\n`)
        return
      }
      if (u.includes("/pending-wake")) { res.writeHead(200); res.end(JSON.stringify({ wake: false })); return }
      if (u.includes("/wake/claim")) {
        if (claimMode === "fail500") { res.writeHead(500); res.end("nope"); return }
        res.writeHead(200); res.end(JSON.stringify({ ok: true, wakeId: "wake-abc123def" }))
        return
      }
      if (u.includes("/wake/delivered")) {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          try { delivered.push(JSON.parse(body)) } catch { /* ignore */ }
          res.writeHead(200); res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const addr = server.address()
    url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : ""
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  it("pushes a notifications/claude/channel and reports delivered with the claimed wakeId", async () => {
    const { stdout } = await runChannel(["--code", "c1", "--part", "pm", "--delivery", "channel", "--debounce", "100"], INIT + "\n" + INITIALIZED + "\n", 1200, url)
    const pushes = rpcResponses(stdout).filter((m) => m.method === "notifications/claude/channel")
    // Exactly one push: the presence (kind:'pager') event must NOT trigger a wake.
    expect(pushes.length, "only the real message should push (pager event ignored)").toBe(1)
    const push = pushes[0]
    expect(push.params.content).toContain("alice")
    expect(push.params.content).toContain("hi")
    expect(push.params.meta.wake).toBe("wake-abc")
    // Fencing: the wake was reported delivered with the claimed wakeId + our holder.
    expect(delivered.length).toBeGreaterThanOrEqual(1)
    expect(delivered[0].wakeId).toBe("wake-abc123def")
    expect(String(delivered[0].holder)).toContain("channel:")
  })

  it("does NOT push or report when the claim fails (fail-closed), and retries", async () => {
    claimMode = "fail500"
    const { stdout, stderr } = await runChannel(["--code", "c1", "--part", "pm", "--delivery", "channel", "--debounce", "100"], INIT + "\n" + INITIALIZED + "\n", 1200, url)
    expect(rpcResponses(stdout).find((m) => m.method === "notifications/claude/channel")).toBeFalsy()
    expect(delivered.length).toBe(0)
    // A 500 (reachable but erroring) is treated as transient -> re-queue + retry.
    expect(stderr).toContain("retry")
  })

  it("recovers and delivers once a transient claim failure clears (never drops)", async () => {
    // Fail the first claim, then succeed: the backoff retry must eventually push.
    claimMode = "fail500"
    const child = spawn("node", [
      CHANNEL, "--code", "c1", "--part", "pm", "--delivery", "channel", "--debounce", "100", "--server", url,
    ], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stdin.write(INIT + "\n" + INITIALIZED + "\n")
    setTimeout(() => { claimMode = "ok" }, 600) // clear the fault after the first failing claim
    await new Promise((r) => setTimeout(r, 3200)) // > first retry (2s) + claim
    child.kill("SIGKILL")
    const push = rpcResponses(stdout).find((m) => m.method === "notifications/claude/channel")
    expect(push, "must deliver after recovery").toBeTruthy()
    expect(delivered.at(-1)?.wakeId).toBe("wake-abc123def")
  })
})

describe("ensureChannelMcp: .mcp.json merge", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rr-mcp-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const read = () => JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))

  it("creates .mcp.json with the relayroom-channel server", () => {
    const r = ensureChannelMcp(dir)
    expect(r).toEqual({ created: true, changed: true })
    expect(read().mcpServers["relayroom-channel"].command).toBe(process.execPath)
  })

  it("preserves existing servers and other top-level keys", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: 1 }))
    ensureChannelMcp(dir)
    const j = read()
    expect(j.mcpServers.other).toEqual({ command: "x" })
    expect(j.mcpServers["relayroom-channel"]).toBeTruthy()
    expect(j.extra).toBe(1)
  })

  it("is idempotent (no change on a second run)", () => {
    ensureChannelMcp(dir)
    expect(ensureChannelMcp(dir)).toEqual({ created: false, changed: false })
  })

  it("backs up a top-level ARRAY .mcp.json instead of silently dropping our server", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify([{ command: "x" }]))
    ensureChannelMcp(dir)
    // The array must not survive as the root (JSON.stringify would drop mcpServers).
    const j = read()
    expect(Array.isArray(j)).toBe(false)
    expect(j.mcpServers["relayroom-channel"]).toBeTruthy()
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json.bak"), "utf8"))).toEqual([{ command: "x" }])
  })

  it("replaces an array-valued mcpServers (would drop our entry) with a fresh map", () => {
    // Valid root object, but mcpServers is an array - assigning a named key onto it
    // would be lost by JSON.stringify. We must start a fresh server map.
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: [], keep: 2 }))
    ensureChannelMcp(dir)
    const j = read()
    expect(Array.isArray(j.mcpServers)).toBe(false)
    expect(j.mcpServers["relayroom-channel"]).toBeTruthy()
    expect(j.keep).toBe(2) // other top-level keys preserved
  })

  it("backs up a malformed .mcp.json", () => {
    writeFileSync(join(dir, ".mcp.json"), "{ not json")
    ensureChannelMcp(dir)
    expect(read().mcpServers["relayroom-channel"]).toBeTruthy()
    expect(readFileSync(join(dir, ".mcp.json.bak"), "utf8")).toBe("{ not json")
  })
})
