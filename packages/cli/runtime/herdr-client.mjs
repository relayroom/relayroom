/**
 * herdr socket client - the delivery substrate for parts that run under herdr instead
 * of tmux.
 *
 * EVERY PROTOCOL FACT BELOW WAS MEASURED against herdr 0.8.0 (protocol 19) on
 * 2026-08-19, not read from documentation. That distinction is not ceremony here: the
 * stage-0 log for this feature exists because the documented behaviour of `agent.prompt`
 * was the opposite of the measured one, and shipping on the document would have made
 * wakes answer security dialogs on the user's behalf.
 *
 *   framing      newline-delimited JSON over a unix socket
 *   request      {"id":"<caller id>","method":"<name>","params":{...}}
 *   success      {"id":"<same id>","result":{...}}
 *   error        {"id":"<same id>","error":{"code":"...","message":"..."}}
 *
 * THE TRAP THAT COST A HANG, and the reason this client does not correlate strictly by
 * id: a request the server cannot parse comes back with **`id: ""`**, not the id that
 * was sent -
 *
 *   -> {"id":"x1","method":"relayroom.does_not_exist","params":{}}
 *   <- {"id":"","error":{"code":"invalid_request","message":"unknown variant ..."}}
 *
 * A client that waits for its own id therefore waits forever on exactly the case it most
 * needs to hear about. Each call here owns its connection and resolves on the first
 * complete message, so an empty-id error is delivered to the caller that caused it.
 *
 * Known error codes seen: `invalid_request` (unknown method / bad shape),
 * `pane_not_found`. Errors are surfaced, never swallowed - a delivery path that treats
 * "I could not ask" as "nothing to do" is the failure this whole feature is correcting.
 */
import net from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"

/** Bounded per-call wait. A hung socket must not stall the pager's flush loop. */
export const HERDR_CALL_TIMEOUT_MS = 5000

/** The minimum server this client claims to understand, and the protocol it was written
 *  against. Both are checked, because they can move independently: a preview build can
 *  keep the version string and change the protocol number. */
export const HERDR_MIN_VERSION = "0.8.0"
export const HERDR_KNOWN_PROTOCOL = 19

/**
 * Where the socket is, in the order the environment establishes it.
 *
 * `HERDR_SOCKET_PATH` is injected into plugin processes by herdr itself (measured), so
 * a pager launched from a plugin action already knows. The default path is where the
 * running server actually put it on this machine - the documented location and the
 * observed one agree, which is not something to assume.
 */
export function herdrSocketPath(env = process.env) {
  return env.HERDR_SOCKET_PATH || join(env.HOME || homedir(), ".config", "herdr", "herdr.sock")
}

/** Is there a herdr server to talk to? A path that exists is not a server that answers,
 *  so callers that need certainty use `handshake()`; this is the cheap pre-check. */
export function herdrSocketPresent(env = process.env) {
  return existsSync(herdrSocketPath(env))
}

/** Compare dotted versions numerically. "0.10.0" > "0.9.0", which a string compare gets
 *  wrong - and a wrong answer here silently disables a working herdr. */
export function versionAtLeast(actual, minimum) {
  const a = String(actual).split(".").map((n) => parseInt(n, 10) || 0)
  const b = String(minimum).split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

export class HerdrError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * One request, one connection, one response.
 *
 * A pooled connection would be fewer syscalls and one more thing to get wrong: herdr
 * also pushes subscription events down a connection, so a shared socket would need the
 * client to demultiplex events from replies. Delivery happens a few times a minute at
 * most. The simple shape is the right trade until an event subscription actually needs
 * one (stage 4), and then it should be its own long-lived connection rather than this
 * one grown.
 */
export function herdrCall(method, params = {}, opts = {}) {
  const path = opts.socketPath || herdrSocketPath()
  const timeoutMs = opts.timeoutMs ?? HERDR_CALL_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const id = `rr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    let done = false
    let buf = ""
    const socket = net.createConnection(path)
    const finish = (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      err ? reject(err) : resolve(value)
    }
    const timer = setTimeout(
      () => finish(new HerdrError("timeout", `herdr ${method} did not answer in ${timeoutMs}ms`)),
      timeoutMs,
    )
    socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"))
    socket.on("data", (chunk) => {
      buf += chunk.toString()
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) }
        catch { finish(new HerdrError("bad_response", `herdr ${method} returned unparseable JSON`)); return }
        // Not `msg.id === id`: see the header. An unparseable request answers with an
        // empty id, and that answer is the one worth hearing.
        if (msg.error) { finish(new HerdrError(msg.error.code || "error", msg.error.message || "herdr error")); return }
        if (msg.id === id) { finish(null, msg.result); return }
        // A reply for someone else on our own private connection should not happen.
        // Ignoring it rather than failing keeps a future protocol addition (a push on
        // the same socket) from breaking delivery.
      }
    })
    socket.on("error", (err) => finish(new HerdrError("socket", err.message)))
    socket.on("close", () => finish(new HerdrError("closed", `herdr closed the connection before answering ${method}`)))
  })
}

/**
 * Ask the SERVER what it is, and refuse to drive one we do not understand.
 *
 * `herdr --version` reports the CLI binary; the running server can be a different build
 * after an update, and it is the server this client talks to. `session.snapshot` carries
 * both `version` and `protocol`, measured.
 *
 * Loud, not silent: an unsupported server returns `{ok:false, reason}` and the caller
 * refuses herdr delivery rather than degrading to something that looks like it worked.
 */
export async function handshake(opts = {}) {
  let snapshot
  try {
    snapshot = await herdrCall("session.snapshot", {}, opts)
  } catch (err) {
    return { ok: false, reason: `herdr socket did not answer (${err.code}: ${err.message})` }
  }
  const version = snapshot?.snapshot?.version ?? "unknown"
  const protocol = snapshot?.snapshot?.protocol ?? null
  if (!versionAtLeast(version, HERDR_MIN_VERSION)) {
    return { ok: false, version, protocol, reason: `herdr ${version} is older than the minimum ${HERDR_MIN_VERSION}` }
  }
  // A protocol bump is a warning, not a refusal: the methods this client uses are the
  // oldest and most stable in the API, and refusing to deliver wakes because a preview
  // build incremented a number would be a worse failure than the one it prevents. The
  // calls themselves fail loudly if a shape actually changed.
  const protocolNote = protocol === HERDR_KNOWN_PROTOCOL
    ? null
    : `herdr protocol ${protocol} differs from the ${HERDR_KNOWN_PROTOCOL} this client was measured against`
  return { ok: true, version, protocol, protocolNote }
}
