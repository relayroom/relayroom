import { createServer, type Server } from "node:http"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
// @ts-expect-error - runtime modules ship as plain .mjs with no type declarations
import { createWakeClient, leaseDecision, backoff } from "../runtime/wake-client.mjs"

/**
 * The wake protocol, tested directly. These cover the module being correct; they do
 * NOT prove either consumer is wired to it - that is what the pager's and channel
 * server's own process-level tests are for, plus the parity guard that keeps the two
 * from quietly growing private copies again.
 */

/** A stub hub. Handlers are per-path; every request is recorded. */
function hub(handlers: Record<string, (req: any, body: string) => { status?: number; body?: string }>) {
  const seen: { path: string; auth?: string; body: string }[] = []
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? ""
    let raw = ""
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      seen.push({ path, auth: req.headers.authorization, body: raw })
      const handler = handlers[path]
      if (!handler) { res.writeHead(404); res.end(); return }
      const out = handler(req, raw)
      res.writeHead(out.status ?? 200, { "content-type": "application/json" })
      res.end(out.body ?? "{}")
    })
  })
  const port = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))
  })
  return { server, port, seen }
}

describe("leaseDecision", () => {
  const HOLDER = "host:1:abc"

  it("treats an unreachable claim as transient, so the caller retries instead of dropping", () => {
    expect(leaseDecision(null, HOLDER)).toEqual({
      go: false,
      reason: "claim unreachable",
      transient: true,
    })
  })

  it("does not nudge when there is no active wake, and that is final", () => {
    const d = leaseDecision({ noWake: true }, HOLDER)
    expect(d.go).toBe(false)
    expect(d.transient).toBeUndefined() // definitive: retrying would spin
  })

  it("stands down when another holder owns the lease, leaving our lease state untouched", () => {
    const d = leaseDecision({ held: true, holder: "other:2:xyz" }, HOLDER)
    expect(d.go).toBe(false)
    expect(d.reason).toContain("other:2:xyz")
    expect("held" in d).toBe(false)
  })

  it("recognizes our own holder rather than reading it as a foreign lease", () => {
    expect(leaseDecision({ held: true, holder: HOLDER, ok: true, wakeId: "w1" }, HOLDER)).toEqual({
      go: true,
      wakeId: "w1",
      held: true,
    })
  })

  it("reports lease lost when the claim is not ok", () => {
    expect(leaseDecision({ ok: false }, HOLDER)).toEqual({
      go: false,
      reason: "lease not held",
      held: false,
    })
  })

  it("fails closed on an ok claim with no wakeId rather than fencing a guess", () => {
    const d = leaseDecision({ ok: true }, HOLDER)
    expect(d.go).toBe(false)
    expect(d.reason).toContain("no wakeId")
    expect(d.held).toBe(true) // we do hold it; there is just nothing to deliver
  })

  it("goes when the claim is ok and carries a wakeId", () => {
    expect(leaseDecision({ ok: true, wakeId: "wake-abc" }, HOLDER)).toEqual({
      go: true,
      wakeId: "wake-abc",
      held: true,
    })
  })
})

describe("backoff", () => {
  it("doubles from the base", () => {
    expect([0, 1, 2, 3].map((n) => backoff(n))).toEqual([500, 1000, 2000, 4000])
  })

  it("stops at the ceiling instead of growing without bound", () => {
    expect(backoff(50)).toBe(30_000)
    // The exponent is capped too: 2 ** 1000 is Infinity, and Infinity * base is NaN
    // in the wrong arrangement - this asserts the cap is real, not incidental.
    expect(Number.isFinite(backoff(1000))).toBe(true)
  })

  it("treats a nonsense attempt count as the first attempt", () => {
    expect(backoff(NaN)).toBe(500)
    expect(backoff(-5)).toBe(500)
  })
})

describe("wake client: server calls", () => {
  let h: ReturnType<typeof hub>
  let url: string

  const client = () =>
    createWakeClient({
      server: url,
      code: "c1",
      part: "core",
      holder: "host:1:abc",
      token: "tok-1",
      fetchTimeoutMs: 2000,
    })

  afterEach(() => h.server.close())

  const start = async (handlers: Parameters<typeof hub>[0]) => {
    h = hub(handlers)
    url = `http://127.0.0.1:${await h.port}`
  }

  it("claims the lease with the bearer and the part/holder pair", async () => {
    await start({ "/mcp/c1/wake/claim": () => ({ body: JSON.stringify({ ok: true, wakeId: "w1" }) }) })
    const lease = await client().claimLease()
    expect(lease).toEqual({ ok: true, wakeId: "w1" })
    const call = h.seen.find((s) => s.path === "/mcp/c1/wake/claim")!
    expect(call.auth).toBe("Bearer tok-1")
    expect(JSON.parse(call.body)).toEqual({ part: "core", holder: "host:1:abc" })
  })

  it("returns null on a rejected claim so the caller fails closed", async () => {
    await start({ "/mcp/c1/wake/claim": () => ({ status: 500, body: "nope" }) })
    expect(await client().claimLease()).toBeNull()
  })

  it("returns null when the hub is unreachable", async () => {
    await start({})
    h.server.close()
    expect(await client().claimLease()).toBeNull()
  })

  it("fences a delivered wake and reads the stale flag back", async () => {
    const logs: string[] = []
    await start({ "/mcp/c1/wake/delivered": () => ({ body: JSON.stringify({ stale: true }) }) })
    const c = createWakeClient({
      server: url,
      code: "c1",
      part: "core",
      holder: "h",
      token: "tok-1",
      log: (...a: unknown[]) => logs.push(a.join(" ")),
    })
    await c.reportDelivered("wake-abcdef123")
    expect(JSON.parse(h.seen[0]!.body)).toMatchObject({ wakeId: "wake-abcdef123" })
    // The channel server used to drop this response on the floor.
    expect(logs.join(" ")).toContain("stale")
  })

  it("does not call the hub with no wakeId to fence", async () => {
    await start({})
    await client().reportDelivered(undefined)
    expect(h.seen).toHaveLength(0)
  })
})

describe("wake client: catch-up", () => {
  let h: ReturnType<typeof hub>
  let url: string

  afterEach(() => h.server.close())

  const start = async (pending: unknown) => {
    h = hub({ "/mcp/c1/pending-wake": () => ({ body: JSON.stringify(pending) }) })
    url = `http://127.0.0.1:${await h.port}`
  }

  const client = () =>
    createWakeClient({ server: url, code: "c1", part: "core", holder: "h", fetchTimeoutMs: 2000 })

  it("enqueues exactly one coalesced wake, never one per unread message", async () => {
    await start({ wake: true, wakeId: "w9", subject: "hi", fromPart: "main", count: 7 })
    const seen: unknown[] = []
    await client().catchUp({ enqueue: (e: unknown) => seen.push(e) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ messageId: "w9", subject: "hi", fromPart: "main", count: 7 })
  })

  it("stays quiet when the server says there is no wake", async () => {
    await start({ wake: false })
    const seen: unknown[] = []
    await client().catchUp({ enqueue: (e: unknown) => seen.push(e) })
    expect(seen).toHaveLength(0)
  })

  it("suppresses a repeat of the SAME wake, so a reconnect burst nudges once", async () => {
    await start({ wake: true, wakeId: "w9", count: 1 })
    const c = client()
    const seen: unknown[] = []
    const enqueue = (e: unknown) => seen.push(e)
    await c.catchUp({ enqueue })
    await c.catchUp({ enqueue })
    await c.catchUp({ enqueue })
    expect(seen).toHaveLength(1)
  })

  it("keeps the cooldown per client, so one part cannot mute another", async () => {
    await start({ wake: true, wakeId: "w9", count: 1 })
    const a: unknown[] = []
    const b: unknown[] = []
    await client().catchUp({ enqueue: (e: unknown) => a.push(e) })
    await client().catchUp({ enqueue: (e: unknown) => b.push(e) })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})

describe("wake client: SSE subscribe", () => {
  let server: Server
  let url: string
  let write: ((chunk: string) => void) | null = null
  let close: (() => void) | null = null

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (!(req.url ?? "").startsWith("/api/sse")) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      // Flush the headers so fetch() resolves and the client starts reading - a real
      // SSE server opens with a comment for the same reason. Comments are ignored by
      // the parser, so this is invisible to every assertion below.
      res.write(": open\n\n")
      write = (chunk: string) => res.write(chunk)
      close = () => res.end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(() => {
    write = null
    close = null
    server.close()
  })

  const client = () =>
    createWakeClient({ server: url, code: "c1", part: "core", holder: "h", token: "t" })

  /** Wait for the stream handler to be installed (the request has landed). */
  const connected = async () => {
    for (let i = 0; i < 100 && !write; i++) await new Promise((r) => setTimeout(r, 10))
  }

  it("delivers a message for this part and ignores presence beats and other parts", async () => {
    const got: any[] = []
    const done = client().subscribe({ onMessage: (e: any) => got.push(e) })
    await connected()
    // A presence beat rides the same stream, one per heartbeat: treated as a message
    // it would enqueue an empty wake every 30s.
    write!(`data: ${JSON.stringify({ kind: "pager", part: "core", online: true })}\n\n`)
    write!(`data: ${JSON.stringify({ kind: "message", part: "web", subject: "not ours" })}\n\n`)
    write!(`data: ${JSON.stringify({ kind: "message", part: "core", subject: "ours" })}\n\n`)
    close!()
    await done
    expect(got.map((e) => e.subject)).toEqual(["ours"])
  })

  it("joins an event split across several data: lines, per the SSE spec", async () => {
    const got: any[] = []
    const done = client().subscribe({ onMessage: (e: any) => got.push(e) })
    await connected()
    const payload = JSON.stringify({ kind: "message", part: "core", subject: "split" })
    const half = Math.floor(payload.length / 2)
    write!(`data: ${payload.slice(0, half)}\ndata: ${payload.slice(half)}\n\n`)
    close!()
    await done
    // Naive per-line parsing would drop this event as invalid JSON, losing the wake.
    expect(got.map((e) => e.subject)).toEqual(["split"])
  })

  it("ignores keepalive comments and named events", async () => {
    const got: any[] = []
    const done = client().subscribe({ onMessage: (e: any) => got.push(e) })
    await connected()
    write!(": keepalive\n\n")
    write!(`event: ping\ndata: ${JSON.stringify({ kind: "message", part: "core" })}\n\n`)
    close!()
    await done
    expect(got).toHaveLength(0)
  })

  it("runs onConnect once the stream is live, which is where catch-up hangs", async () => {
    let connects = 0
    const done = client().subscribe({ onMessage: () => {}, onConnect: () => connects++ })
    await connected()
    close!()
    await done
    expect(connects).toBe(1)
  })

  it("gives up on a silent connection instead of blocking forever", async () => {
    // A half-open socket delivers nothing and never ends. Without the watchdog the
    // read blocks and the part stops waking with no error anywhere.
    const started = Date.now()
    await expect(client().subscribe({ onMessage: () => {}, idleMs: 150 })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("rejects a refused subscription so the caller reconnects", async () => {
    const bad = createWakeClient({ server: `${url}/nope`, code: "c1", part: "core", holder: "h" })
    await expect(bad.subscribe({ onMessage: () => {} })).rejects.toThrow(/SSE 404/)
  })

  it("sends the bearer on the stream request", async () => {
    let auth: string | undefined
    const probe = createServer((req, res) => {
      auth = req.headers.authorization
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end()
    })
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r))
    const probeUrl = `http://127.0.0.1:${(probe.address() as { port: number }).port}`
    const c = createWakeClient({ server: probeUrl, code: "c1", part: "core", holder: "h", token: "tok-sse" })
    await c.subscribe({ onMessage: () => {} })
    probe.close()
    expect(auth).toBe("Bearer tok-sse")
  })
})

/**
 * The layer that keeps this refactor from undoing itself.
 *
 * Unit tests prove the module is right; each consumer's own tests prove today's
 * behavior is right. Neither notices if someone re-inlines a copy of claimLease into
 * one runtime tomorrow - both suites would stay green while the two paths drift
 * apart again, which is exactly how they got here. Only a source-level assertion
 * catches that, so this is deliberately a scan and not a behavioral test.
 */
describe("wake protocol: one implementation", () => {
  const RUNTIME_DIR = fileURLToPath(new URL("../runtime/", import.meta.url))
  const CONSUMERS = ["relayroom-pager.mjs", "relayroom-channel.mjs"]
  // Names that must exist in exactly one place. `authHeaders` is included because a
  // private copy is how the bearer drifted between the two in the first place.
  const SHARED = ["authHeaders", "claimLease", "reportDelivered", "leaseDecision", "sseUrl", "catchUp"]

  for (const consumer of CONSUMERS) {
    it(`${consumer} defines none of the shared wake functions itself`, () => {
      const src = readFileSync(join(RUNTIME_DIR, consumer), "utf8")
      for (const name of SHARED) {
        const defined = new RegExp(`(async\\s+)?function\\s+${name}\\b|(const|let)\\s+${name}\\s*=`).test(src)
        expect(defined, `${consumer} re-declares ${name}; it belongs to wake-client.mjs`).toBe(false)
      }
    })

    it(`${consumer} gets its wake client from the shared module`, () => {
      const src = readFileSync(join(RUNTIME_DIR, consumer), "utf8")
      expect(src).toMatch(/import \{[^}]*createWakeClient[^}]*\} from "\.\/wake-client\.mjs"/)
    })
  }

  it("keeps both consumers on one retry curve", () => {
    // A per-consumer base or exponent cap is what produced a 4x difference in wait
    // between two paths doing the same thing, with no recorded reason.
    for (const consumer of CONSUMERS) {
      const src = readFileSync(join(RUNTIME_DIR, consumer), "utf8")
      const calls = src.split(/\bbackoff\(/).slice(1)
      for (const call of calls) {
        const args = call.slice(0, call.indexOf(")"))
        expect(args, `${consumer} overrides the shared backoff curve`).not.toContain("baseMs")
        expect(args, `${consumer} overrides the shared backoff curve`).not.toContain("maxExponent")
      }
    }
  })
})
