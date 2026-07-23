import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const PAGER = fileURLToPath(new URL("../runtime/relayroom-pager.mjs", import.meta.url))

/**
 * The runtime endpoints are moving from connect-code trust to a required bearer.
 * The pager must therefore send its token on EVERY call before the server starts
 * demanding one - a call that forgets it fails closed and silently (they are all
 * wrapped in `catch {}`), which shows up as presence and wakes quietly dying.
 */
describe("pager: bearer on every runtime call", () => {
  let child: ChildProcess | undefined
  let server: Server | undefined

  afterEach(() => {
    child?.kill("SIGKILL")
    server?.close()
  })

  it("authenticates heartbeat, SSE and pending-wake", async () => {
    const seen = new Map<string, string | undefined>()
    server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0] ?? ""
      seen.set(path, req.headers.authorization)
      if (path === "/api/sse") {
        // Hold the stream open so the pager stays connected and runs catch-up.
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(": ok\n\n")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ wake: false }))
    })
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port))
    })

    child = spawn(
      "node",
      [
        PAGER,
        "--code", "c1",
        "--part", "core",
        // A tmux target that does not exist: every tmux call fails harmlessly and
        // nothing is ever typed anywhere.
        "--target", "relayroom-test-no-such-session",
        "--server", `http://127.0.0.1:${port}`,
        "--token", "tok-abc",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    )

    // Heartbeat fires immediately, SSE connects, catch-up follows the connect.
    await new Promise((r) => setTimeout(r, 1500))

    expect(seen.get("/mcp/c1/heartbeat")).toBe("Bearer tok-abc")
    expect(seen.get("/api/sse")).toBe("Bearer tok-abc")
    expect(seen.get("/mcp/c1/pending-wake")).toBe("Bearer tok-abc")
  })
})

/**
 * The live test can only cover the calls a healthy pager makes in its first
 * seconds. This covers the rest (releaseLease fires from a signal handler as the
 * process exits, wake/claim and wake/delivered only under an active wake) by
 * asserting no `fetch(` in either runtime is built without auth. The channel
 * server is a near-copy of the pager, so it is held to the same rule.
 */
describe("runtime: no unauthenticated fetch", () => {
  // Scan every shipped runtime rather than a fixed pair: the wake calls moved into
  // wake-client.mjs when the pager and channel server were de-duplicated, and a list
  // of filenames would have silently stopped covering them.
  const RUNTIME_DIR = fileURLToPath(new URL("../runtime/", import.meta.url))
  const withFetch = readdirSync(RUNTIME_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => readFileSync(join(RUNTIME_DIR, f), "utf8").includes("fetch("))

  it("finds runtimes that call the hub at all", () => {
    expect(withFetch.length).toBeGreaterThan(0)
  })

  for (const name of withFetch) {
    it(`${name} passes a bearer on every fetch`, () => {
      const src = readFileSync(join(RUNTIME_DIR, name), "utf8")
      for (const call of src.split(/\bfetch\(/).slice(1)) {
        const head = call.slice(0, 400)
        // The shared helper, or a call that assembles its own headers object.
        expect(head, `unauthenticated fetch in ${name}`).toMatch(/authHeaders\(|headers[,:]/)
      }
    })
  }
})
