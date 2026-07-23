#!/usr/bin/env node
/**
 * RelayRoom channel server — the Claude-specific PREMIUM wake path.
 *
 * Claude Code's Channels feature (research preview, v2.1.80+) lets an MCP server
 * PUSH events that Claude queues and processes at a TURN BOUNDARY, so they never
 * interleave with the user's typing — the clean version of what the pager's
 * `send-keys` deferral approximates. This is a per-session stdio MCP subprocess
 * that Claude spawns (via `.mcp.json` + `--dangerously-load-development-channels
 * server:relayroom-channel`). It subscribes to the RelayRoom stream for THIS
 * worktree's part and, on a new wake, pushes `notifications/claude/channel`.
 *
 * STDOUT IS THE MCP TRANSPORT (newline-delimited JSON-RPC). All logging MUST go to
 * stderr, or it would corrupt the protocol stream.
 *
 * It reuses the same server-side wake state machine as the pager (claimLease ->
 * notify -> reportDelivered, server settles on caught-up). No `tmux`, no defer, no
 * `paneQuiet`: turn-boundary queueing is native. The pager still runs alongside for
 * heartbeat / statusline / presence; its `flush` is gated off under delivery=channel.
 *
 * Usage (normally invoked by Claude via .mcp.json):
 *   node relayroom-channel.mjs [--code <connect_code>] [--part <part>] [--server url] [--token <bearer>]
 * Missing flags fall back to .relayroom/config.json (written by `relayroom init`).
 */
import { readFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

// ── Args + config ─────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const CFG_DIR = arg("dir", process.cwd())
const CFG = (() => {
  try { return JSON.parse(readFileSync(join(CFG_DIR, ".relayroom", "config.json"), "utf8")) || {} }
  catch { return {} }
})()
const CODE = arg("code", CFG.code)
const PROJECT = arg("project")
const PART = arg("part", CFG.part)
const SERVER = arg("server", CFG.server ?? "http://localhost:48801")
const TOKEN = arg("token", CFG.token)
const DEBOUNCE_MS = Number(arg("debounce", "1200"))
const FETCH_TIMEOUT_MS = 8000
// This server is always present in .mcp.json so `--channels server:relayroom-channel`
// can reference it, but it only DELIVERS when the worktree is in channel mode. Under
// pager mode it completes the MCP handshake and then stays DORMANT (no SSE, no claim,
// no push), so the pager owns wakes with zero conflict. rr.sh sets `delivery`.
const DELIVERY = arg("delivery", CFG.delivery ?? "pager")

// All diagnostics go to STDERR — stdout is the MCP JSON-RPC transport.
const log = (...a) => console.error(`[channel ${PART ?? "?"}]`, ...a)

// CODE is REQUIRED: lease/wake/catch-up are connect-code keyed. A --project-only
// start could never claim a lease, so the transient-retry loop would spin forever.
if (!CODE || !PART) {
  log("usage: relayroom-channel --code <connect_code> --part <part> [--server url] [--token bearer]")
  process.exit(1)
}

// Lease identity: distinct from the pager's HOLDER so the two never collide. While
// delivery=channel the pager does not flush (so it never claims), so this server
// holds the active wake's lease uncontested.
const HOLDER = `channel:${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`

function authHeaders(extra) {
  const h = { ...(extra ?? {}) }
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`
  return h
}

// ── MCP stdio transport (raw JSON-RPC, newline-delimited) ─────────────────────
// Zero-dep: the only MCP surface we need is the initialize handshake + a single
// custom outbound notification, so a raw transport keeps this script as portable
// as the pager (no node_modules to ship).
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

// Push a Channels event. Claude renders it as <channel source meta...>content</channel>
// at its next turn boundary. meta values must be strings (each becomes an attribute).
function sendChannel(content, meta) {
  const params = { content }
  if (meta) {
    const clean = {}
    for (const [k, v] of Object.entries(meta)) if (v != null && v !== "") clean[k] = String(v)
    if (Object.keys(clean).length) params.meta = clean
  }
  send({ jsonrpc: "2.0", method: "notifications/claude/channel", params })
}

let initialized = false

// MCP protocol versions we actually speak. Per the MCP handshake, the server echoes
// the client's version IFF it supports it, else replies with its own latest — never
// claim support for an arbitrary version the client names.
const SUPPORTED_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"])
const LATEST_PROTOCOL = "2025-06-18"

// The version we advertise in the MCP handshake, read from the package we ship
// inside - the same way the pager reports its version on each heartbeat. A literal
// here would be a second copy of the release number that nothing bumps.
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || null }
  catch { return null }
})()

function handleRpc(msg) {
  // Requests carry an id and need a response; notifications (no id) do not.
  const { id, method } = msg
  if (method === "initialize") {
    // Advertise ONLY the channel capability (no tools/resources => Claude never
    // calls tools/list). Negotiate the protocol version: echo the client's only when
    // we support it, otherwise fall back to our latest.
    const requested = msg.params?.protocolVersion
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : LATEST_PROTOCOL
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { experimental: { "claude/channel": {} } },
        // serverInfo.version must be a string; fall back only if package.json could
        // not be read (a broken install), which is also what the CLI banner does.
        serverInfo: { name: "relayroom-channel", version: VERSION ?? "0.0.0-dev" },
        instructions:
          'RelayRoom delivers new-message wakes here as <channel source="relayroom">. ' +
          "When one arrives, use the RelayRoom `inbox` MCP tool to read it (NOT curl/shell). " +
          "Reply ONLY if it needs an answer; otherwise just ack it. Do NOT reply to " +
          "acknowledge or confirm. Close the thread when it's resolved.",
      },
    })
    return
  }
  if (method === "notifications/initialized") {
    if (!initialized) { initialized = true; startWakePipeline() }
    return
  }
  if (method === "ping") { if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} }); return }
  // Any other REQUEST: we expose no tools/resources/prompts. Reply method-not-found
  // so the client doesn't hang waiting; ignore unknown NOTIFICATIONS silently.
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
}

function readStdin() {
  let buf = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      try { handleRpc(msg) } catch (err) { log("rpc error:", err.message) }
    }
  })
  // Claude closing stdin means the session is gone — exit so we don't linger.
  process.stdin.on("end", () => process.exit(0))
}

// ── Wake state machine (mirrors the pager; no tmux / defer) ───────────────────
async function claimLease() {
  if (!CODE) return null
  try {
    const res = await fetch(`${SERVER}/mcp/${encodeURIComponent(CODE)}/wake/claim`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ part: PART, holder: HOLDER }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function reportDelivered(wakeId) {
  if (!CODE || !wakeId) return
  try {
    await fetch(`${SERVER}/mcp/${encodeURIComponent(CODE)}/wake/delivered`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ part: PART, holder: HOLDER, wakeId }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch { /* best-effort; server ignores stale wakeIds */ }
}

// FAIL-CLOSED: only deliver when we hold the lease AND the server returned a concrete
// wakeId. `transient:true` marks a TEMPORARY failure (server unreachable) worth a
// bounded retry — unlike the pager, a live channel session may not get an SSE
// reconnect to re-trigger catch-up, so dropping a transient claim could strand the
// wake until it stale-expires. Definitive outcomes (noWake / held-by-other / ok but
// no wakeId) are dropped: nothing to deliver, someone else delivers, or fail-closed.
function leaseDecision(lease) {
  if (!lease) return { go: false, reason: "claim unreachable", transient: true }
  if (lease.noWake) return { go: false, reason: "no active wake" }
  if (lease.held && lease.holder !== HOLDER) return { go: false, reason: `lease held by ${lease.holder}` }
  if (!lease.ok) return { go: false, reason: "lease not held" }
  if (!lease.wakeId) return { go: false, reason: "claim ok but no wakeId" }
  return { go: true, wakeId: lease.wakeId }
}

function buildContent(batch) {
  const guidance =
    "Use the RelayRoom `inbox` MCP tool to read (NOT curl/shell - the HTTP API 404s and " +
    "won't mark anything read). Reply ONLY if it needs an answer; otherwise just ack it. " +
    "Do NOT reply to acknowledge or confirm. Close the thread when it's resolved."
  if (batch.length === 1) {
    const e = batch[0]
    const subj = e.subject ? ` "${e.subject}"` : ""
    const who = e.fromPart ? ` from ${e.fromPart}` : ""
    return `New RelayRoom message${subj}${who} for part "${PART}". ${guidance}`
  }
  const froms = [...new Set(batch.map((e) => e.fromPart).filter(Boolean))].join(", ")
  return `${batch.length} new RelayRoom messages for part "${PART}"${froms ? ` (from ${froms})` : ""}. ${guidance}`
}

// ── Debounced delivery (single-flight) ────────────────────────────────────────
let pending = []
let timer = null
let flushing = false
let transientRetries = 0
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30_000 // backoff cap; we keep retrying for the session's lifetime

function enqueue(evt) {
  pending.push(evt)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE_MS)
}

async function flush() {
  timer = null
  if (!initialized) return // defensive: SSE only starts post-initialize, so nothing enqueues earlier
  if (flushing) return
  flushing = true
  try {
    while (pending.length > 0) {
      const batch = pending
      pending = []
      // Claim the lease for the part's active wake. No defer/re-claim is needed:
      // there is no long wait between claim and delivery (Channels queues at the
      // turn boundary itself), so the claim and the notify are effectively atomic.
      const decision = leaseDecision(await claimLease())
      if (!decision.go) {
        // Transient (server unreachable / claim errored): re-queue and retry with
        // exponential backoff (cap RETRY_MAX_MS) for the session's lifetime - never
        // drop, since the server sweep EXCLUDES agents that already have an active
        // wake, so a dropped transient would strand the wake until it stale-expires.
        // The counter only sets the backoff level (a merged batch inheriting it just
        // waits a bit longer); a successful push or a definitive skip resets it.
        if (decision.transient) {
          const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(transientRetries, 4))
          transientRetries++
          pending.unshift(...batch)
          if (!timer) timer = setTimeout(flush, delay)
          log(`channel push deferred: ${decision.reason} (retry #${transientRetries} in ${delay}ms)`)
          break
        }
        transientRetries = 0
        log(`skip channel push: ${decision.reason}`)
        continue
      }
      transientRetries = 0
      const subj = batch.find((e) => e.subject)?.subject
      const from = [...new Set(batch.map((e) => e.fromPart).filter(Boolean))].join(", ")
      sendChannel(buildContent(batch), { from, subject: subj, wake: String(decision.wakeId).slice(0, 8) })
      log(`channel push: ${batch.length} msg (wake ${String(decision.wakeId).slice(0, 8)})`)
      await reportDelivered(decision.wakeId) // fence pending -> delivered
    }
  } finally {
    flushing = false
  }
}

// ── SSE subscription + reconnect catch-up (copied from the pager) ─────────────
function sseUrl() {
  const u = new URL(`${SERVER}/api/sse`)
  if (CODE) u.searchParams.set("code", CODE)
  else u.searchParams.set("project", PROJECT)
  u.searchParams.set("part", PART)
  return u.toString()
}

// Idle watchdog: server pings ~15s; no bytes for this long => half-open => reconnect.
const SSE_IDLE_MS = 45_000

async function subscribe() {
  const headers = { accept: "text/event-stream" }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  const ctrl = new AbortController()
  const res = await fetch(sseUrl(), { headers, signal: ctrl.signal })
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status} ${res.statusText}`)
  log(`connected → ${sseUrl()}`)
  void catchUp()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let eventName = "message"
  let dataLines = [] // SSE: an event may span multiple data: lines, joined by \n

  const dispatchEvent = () => {
    if (dataLines.length && eventName === "message") {
      try {
        const evt = JSON.parse(dataLines.join("\n"))
        // Only real messages, not presence events (kind:'pager' from heartbeats),
        // which share this stream but carry no message and would spuriously wake.
        if (evt.part === PART && evt.kind === "message") { log(`event: "${evt.subject ?? ""}" from ${evt.fromPart ?? "?"}`); enqueue(evt) }
      } catch { /* non-JSON keepalive — ignore */ }
    }
    eventName = "message"
    dataLines = []
  }

  let idle = setTimeout(() => ctrl.abort(), SSE_IDLE_MS)
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), SSE_IDLE_MS) }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bump()
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "")
        buf = buf.slice(idx + 1)
        if (line === "") { dispatchEvent(); continue }
        if (line.startsWith(":")) continue
        if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue }
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
      }
    }
  } finally {
    clearTimeout(idle)
  }
}

// Coalesce repeated catch-ups for the SAME wake across reconnect bursts.
let lastCatchupWakeId = null
let lastCatchupAt = 0
const CATCHUP_COOLDOWN_MS = 30_000

async function catchUp() {
  if (!CODE) return
  try {
    const u = new URL(`${SERVER}/mcp/${encodeURIComponent(CODE)}/pending-wake`)
    u.searchParams.set("part", PART)
    u.searchParams.set("holder", HOLDER)
    const res = await fetch(u, { headers: authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return
    const d = await res.json()
    if (!d.wake) { if (d.suppressed) log("catch-up: budget-suppressed, sweep will recover"); return }
    const nowTs = Date.now()
    if (d.wakeId === lastCatchupWakeId && nowTs - lastCatchupAt < CATCHUP_COOLDOWN_MS) return
    lastCatchupWakeId = d.wakeId
    lastCatchupAt = nowTs
    enqueue({ subject: d.subject, fromPart: d.fromPart, messageId: d.wakeId, count: d.count })
    log(`catch-up: 1 coalesced wake (${d.count ?? "?"} unread)`)
  } catch (err) { log("catch-up failed:", err.message) }
}

// ── Run ───────────────────────────────────────────────────────────────────────
// The wake pipeline (SSE subscribe + delivery) starts only after
// `notifications/initialized`, when the session is ready to receive channel events.
// Because SSE only starts here, no events can arrive before initialization.
let pipelineStarted = false
function startWakePipeline() {
  if (pipelineStarted) return
  pipelineStarted = true
  if (DELIVERY !== "channel") {
    // Dormant: handshake done, but the pager (delivery=pager) owns wakes. Do not
    // subscribe/claim/push, so we never double-wake or fight the pager for the lease.
    log(`dormant (delivery=${DELIVERY}); the pager owns wakes for part=${PART}`)
    return
  }
  log(`channel ready for ${CODE ? `code=${CODE}` : `project=${PROJECT}`} part=${PART} (server ${SERVER})`)
  ;(async () => {
    for (;;) {
      try { await subscribe(); log("stream ended; reconnecting in 2s") }
      catch (err) { log("stream error:", err.message, "— retry in 2s") }
      await new Promise((r) => setTimeout(r, 2000))
    }
  })()
}

readStdin()
