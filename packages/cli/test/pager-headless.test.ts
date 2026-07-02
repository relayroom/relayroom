import { describe, expect, it } from "vitest"
// @ts-expect-error - runtime .mjs has no type declarations; tested at runtime only.
import { buildHeadlessPrompt, headlessSpawnSpec, makeWakeDedup } from "../runtime/pager-headless.mjs"

describe("buildHeadlessPrompt", () => {
  it("counts unread across the batch (sum of count, default 1 each)", () => {
    const p = buildHeadlessPrompt([{ count: 3 }, {}], "wake123456", "agent-codex")
    expect(p).toContain("4 unread RelayRoom messages")
  })

  it("uses the singular form for exactly one message", () => {
    const p = buildHeadlessPrompt([{ count: 1 }], "w", "agent-agy")
    expect(p).toContain("1 unread RelayRoom message ")
    expect(p).not.toContain("1 unread RelayRoom messages")
  })

  it("includes the part name and a short wake tag", () => {
    const p = buildHeadlessPrompt([{}], "abcdef0123456789", "agent-codex")
    expect(p).toContain('part "agent-codex"')
    expect(p).toContain("(wake abcdef01)") // wakeId truncated to 8 chars
  })

  it("tells the agent to use the inbox MCP tool, not curl/shell", () => {
    const p = buildHeadlessPrompt([{}], "w", "p")
    expect(p).toContain("`inbox` MCP tool")
    expect(p).toContain("NOT curl/shell")
  })

  it("mandates acking every read message so the wake settles (no re-spawn loop)", () => {
    const p = buildHeadlessPrompt([{}], "w", "p")
    expect(p).toContain("MUST `ack` every message")
    expect(p).toContain("spawned again for the same wake")
  })

  it("tolerates an empty batch and a missing wakeId", () => {
    const p = buildHeadlessPrompt([], undefined, "p")
    expect(p).toContain("0 unread RelayRoom messages")
    expect(p).not.toContain("(wake")
  })
})

describe("headlessSpawnSpec", () => {
  it("builds a codex exec spec and injects the bearer via RELAYROOM_TOKEN env", () => {
    const spec = headlessSpawnSpec("codex", { token: "tok_abc", prompt: "do it" })
    expect(spec).toEqual({
      command: "codex",
      args: ["exec", "--profile", "relayroom", "do it"],
      env: { RELAYROOM_TOKEN: "tok_abc" },
    })
  })

  it("omits the token env when no token is provided (codex)", () => {
    const spec = headlessSpawnSpec("codex", { prompt: "x" })
    expect(spec.env).toEqual({})
  })

  it("builds an agy print spec with no env injection (token is baked into its config)", () => {
    const spec = headlessSpawnSpec("agy", { token: "ignored", prompt: "hi" })
    expect(spec).toEqual({ command: "agy", args: ["-p", "hi"], env: {} })
  })

  it("returns null for claude (never runs headless here) and for unknown/empty CLIs", () => {
    expect(headlessSpawnSpec("claude", { prompt: "x" })).toBeNull()
    expect(headlessSpawnSpec("", { prompt: "x" })).toBeNull()
    expect(headlessSpawnSpec(undefined, { prompt: "x" })).toBeNull()
    expect(headlessSpawnSpec("gemini", { prompt: "x" })).toBeNull()
  })
})

describe("makeWakeDedup", () => {
  it("reports a wake as seen only after it is marked", () => {
    const d = makeWakeDedup()
    expect(d.has("w1")).toBe(false)
    d.mark("w1")
    expect(d.has("w1")).toBe(true)
    expect(d.has("w2")).toBe(false)
  })

  it("ignores empty/falsy wakeIds (never marks, never matches)", () => {
    const d = makeWakeDedup()
    d.mark("")
    d.mark(undefined)
    expect(d.has("")).toBe(false)
    expect(d.has(undefined)).toBe(false)
    expect(d.size).toBe(0)
  })

  it("evicts the oldest wakeId once the cap is exceeded (bounded memory)", () => {
    const d = makeWakeDedup(3)
    d.mark("a"); d.mark("b"); d.mark("c")
    expect(d.size).toBe(3)
    d.mark("d") // evicts "a" (oldest)
    expect(d.size).toBe(3)
    expect(d.has("a")).toBe(false)
    expect(d.has("b")).toBe(true)
    expect(d.has("d")).toBe(true)
  })

  it("treats a negative cap as zero instead of looping forever", () => {
    const d = makeWakeDedup(-1)
    d.mark("a")
    expect(d.size).toBe(0)
    expect(d.has("a")).toBe(false)
  })

  it("re-marking an existing wakeId does not grow the set", () => {
    const d = makeWakeDedup(3)
    d.mark("a"); d.mark("a"); d.mark("a")
    expect(d.size).toBe(1)
  })
})
