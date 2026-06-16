#!/usr/bin/env node
/**
 * RelayRoom pager — wakes an idle, INTERACTIVE Claude Code session when a new
 * message arrives for its part, without headless `claude -p` (newly metered) and
 * without relying on turn-boundary hooks (which can't fire on a truly idle session).
 *
 * How it works:
 *   1. Subscribe to the RelayRoom server SSE for a (project, part) — the stream
 *      only carries events addressed to that part.
 *   2. On a `message` event, debounce a short burst, then `tmux send-keys` a small
 *      nudge into the part's tmux session/pane. The interactive Claude Code there
 *      receives it as a user turn and wakes up to call the RelayRoom MCP tools.
 *
 * The Claude Code session stays interactive (subscription-covered) — send-keys just
 * types for it instead of a human. The waker itself is a tiny non-LLM process.
 *
 * Usage:
 *   node relayroom-pager.mjs --code <connect_code> --part <part> --target <tmux-target> \
 *     [--server http://localhost:48801] [--debounce 1200] [--token <bearer>]
 *
 * The connect_code (the same one used for `claude mcp add`) is the unambiguous,
 * globally-unique project key — it resolves to the project UUID server-side, so
 * the stream is never confused by two orgs sharing a project slug.
 *
 * Example:
 *   node relayroom-pager.mjs --code demo-7c3b59048dfc --part backend --target relayroom-backend
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

// ── Args ────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// Fall back to .relayroom/config.json (written by `relayroom init`) for any field
// not passed as a flag, so a restarted/compacted agent recovers its identity.
const CFG_DIR = arg("dir", process.cwd())
const CFG = (() => {
  try { return JSON.parse(readFileSync(join(CFG_DIR, ".relayroom", "config.json"), "utf8")) || {} }
  catch { return {} }
})()

const CODE = arg("code", CFG.code) // connect_code (preferred — unambiguous project key)
const PROJECT = arg("project") // legacy slug fallback
const PART = arg("part", CFG.part)
const TARGET = arg("target", CFG.target) // tmux target: session, session:window.pane, etc.
const SERVER = arg("server", CFG.server ?? "http://localhost:48801")
const DEBOUNCE_MS = Number(arg("debounce", "1200"))
const TOKEN = arg("token") // optional agent bearer; needed only if /api/sse enforces auth
const DIR = arg("dir", process.cwd()) // worktree dir; used to detect RELAYROOM.md
const HEARTBEAT_MS = 30000
// Wake delivery path (set by rr.sh). "channel" => a Claude Code Channels server
// pushes wakes; the pager must NOT also send-keys (double-wake). Under "channel" the
// pager runs heartbeat/statusline/presence only and skips SSE + flush entirely.
const DELIVERY = arg("delivery", CFG.delivery ?? "pager")
// K: send-keys retries after the first fire. Clamp to a finite [0, 8] so a bad
// --retries (NaN, negative, or Infinity) can't turn retryTmux into an unbounded loop.
const RETRY_MAX = (() => {
  const n = Math.floor(Number(arg("retries", "3")))
  return Number.isFinite(n) ? Math.min(8, Math.max(0, n)) : 3
})()
const RETRY_BASE_MS = 500                      // backoff base

// CODE (connect code) is REQUIRED: the lease/wake/heartbeat endpoints are all
// connect-code keyed. A --project-only (legacy slug) start can subscribe to SSE but
// can never claim a lease, so it would fail-closed forever (or, with the backoff
// re-queue, spin). Require CODE so that can't happen.
if (!CODE || !PART || !TARGET) {
  console.error("usage: node relayroom-pager.mjs --code <connect_code> --part <part> --target <tmux-target> [--server url] [--debounce ms] [--token bearer] [--retries K]")
  process.exit(1)
}

const log = (...a) => console.log(`[pager ${PART}]`, ...a)

// Readable text color for a hex background, by perceived luminance (tmux does not
// auto-invert text on a colored status bar, so we choose black/white ourselves).
function contrastOn(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#000000" : "#ffffff"
}

// ── Lease holder identity + state ─────────────────────────────────────────────
// Single-pager-per-part is no longer a machine-local lockfile; it is now the
// server-side per-part lease (wakeIntents.leaseHolder). Two pagers on different
// machines can both start, but only the lease holder nudges. HOLDER uniquely
// identifies THIS live pager process across part rotation / restart.
const HOLDER = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`
let leaseHeld = false       // last lease state seen from heartbeat/claim
// NOTE: the fencing wakeId is no longer tracked as ambient state. flush() captures
// it locally from the authoritative post-defer lease re-claim, which removed the
// races that ambient tracking caused (a heartbeat/SSE update could redirect a
// report to the wrong wake mid-defer).

function authHeaders(extra) {
  const h = { ...(extra ?? {}) }
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`
  return h
}

// Best-effort lease release on shutdown. fire-and-forget (cannot await in a
// signal handler); the server lease TTL backstops a dropped call.
const releaseLease = () => {
  if (!CODE) return
  fetch(`${SERVER}/mcp/${encodeURIComponent(CODE)}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ part: PART, holder: HOLDER, release: true }),
  }).catch(() => {})
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { releaseLease(); process.exit(0) })

// ── tmux nudge ──────────────────────────────────────────────────────────────
const TMUX_TIMEOUT_MS = 5000 // kill a hung tmux child so the defer loop can't wait forever
// Cap every server fetch: a hung claim/delivered call inside flush() would otherwise
// pin the single-flight `flushing` flag true forever and stall all later nudges.
const FETCH_TIMEOUT_MS = 8000

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: TMUX_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve()
    })
  })
}

// Capture tmux stdout. Returns { ok, out }: ok=false distinguishes a capture
// failure (tmux error/timeout) from a genuinely empty pane (ok=true, out="").
function tmuxCapture(args) {
  return new Promise((resolve) => {
    execFile("tmux", args, { timeout: TMUX_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? { ok: false, out: "" } : { ok: true, out: String(stdout) })
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Bare login/interactive shells: if the target pane's foreground command is one of
// these, the agent (claude/codex/gemini) has EXITED. Typing a wake into a shell
// just spams it (and errors), so we skip the nudge until the agent is back.
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "tcsh", "dash", "ksh", "-zsh", "-bash", "-sh"])
async function agentPresent() {
  const { ok, out } = await tmuxCapture(["display-message", "-p", "-t", TARGET, "#{pane_current_command}"])
  if (!ok) return true // can't tell (session/tmux issue) - don't block on uncertainty
  return !SHELL_COMMANDS.has(out.trim())
}

// Defer-until-quiet: inject only when the pane is quiet, so a nudge never lands in
// the middle of what the user is typing (or the agent's streaming output). Two
// signals, both best-effort across the claude/codex/gemini TUIs:
//   1. copy/scroll mode (#{pane_in_mode}=1): keys would be swallowed - always defer.
//   2. content stability: snapshot twice STABLE_GAP_MS apart; identical = quiet.
// Notification delay is acceptable (the wake is never lost; flush re-validates after).
// KNOWN LIMIT: a user who types then PAUSES without submitting looks "stable", so a
// nudge can still append to their line. Screen-capture cannot reliably detect a
// paused half-composed line cross-TUI. Claude Code's Channels path (separate work)
// removes this for claude; for codex/gemini this stays best-effort.
const STABLE_GAP_MS = 600       // snapshot interval to judge "quiet"
const DEFER_POLL_MS = 1500      // re-check cadence while busy
const DEFER_MAX_MS = 120_000    // cap: inject anyway after this, never hang forever

async function paneQuiet() {
  const mode = await tmuxCapture(["display-message", "-p", "-t", TARGET, "#{pane_in_mode}"])
  if (mode.ok && mode.out.trim() === "1") return false // copy/scroll mode - keys would be eaten
  const a = await tmuxCapture(["capture-pane", "-p", "-t", TARGET])
  if (!a.ok) return true // can't capture (session gone / tmux issue) - don't block
  await sleep(STABLE_GAP_MS)
  const b = await tmuxCapture(["capture-pane", "-p", "-t", TARGET])
  if (!b.ok) return true
  return a.out === b.out
}

async function waitUntilQuiet() {
  const deadline = Date.now() + DEFER_MAX_MS
  while (!(await paneQuiet())) {
    if (Date.now() >= deadline) { log("pane busy too long - injecting anyway"); return }
    await sleep(DEFER_POLL_MS)
  }
}

// If the pane is in copy/scroll mode, send-keys is routed to copy-mode (navigation)
// and our nudge is SWALLOWED - so we'd reportDelivered for a wake the agent never
// saw. Cancel copy-mode first (best-effort; a no-op error when not in a mode is fine)
// so the subsequent send-keys reaches the shell/agent.
async function exitCopyMode() {
  const mode = await tmuxCapture(["display-message", "-p", "-t", TARGET, "#{pane_in_mode}"])
  if (mode.ok && mode.out.trim() === "1") {
    await tmux(["send-keys", "-t", TARGET, "-X", "cancel"]).catch(() => {})
  }
}

// Run one tmux op with bounded exponential-backoff retries. Returns true on success.
async function retryTmux(args) {
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try { await tmux(args); return true }
    catch (err) {
      if (attempt === RETRY_MAX) { log(`tmux gave up after ${RETRY_MAX} retries (sweep will re-issue):`, err.message); return false }
      await sleep(RETRY_BASE_MS * 2 ** attempt)
    }
  }
  return false
}

// Deliver the nudge. The text and the submitting Enter retry on SEPARATE loops: if
// the text lands but Enter fails, retrying the whole pair would append the text a
// second time ("texttext"). So we only advance to Enter once the text is in.
async function sendKeysOnce(text) {
  await exitCopyMode()
  // -l sends the text literally (no key-name interpretation); Enter submits it.
  if (!(await retryTmux(["send-keys", "-t", TARGET, "-l", "--", text]))) return false
  return await retryTmux(["send-keys", "-t", TARGET, "Enter"])
}

// Claim the server-side lease for this part's active wake. Returns the response
// JSON ({ ok, held?, holder?, wakeId?, noWake? }) or null on transport failure.
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

// Fencing: report that we nudged with wakeId. The server ignores stale wakeIds.
async function reportDelivered(wakeId) {
  if (!CODE || !wakeId) return
  try {
    const res = await fetch(`${SERVER}/mcp/${encodeURIComponent(CODE)}/wake/delivered`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ part: PART, holder: HOLDER, wakeId }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.ok) {
      const d = await res.json().catch(() => ({}))
      if (d.stale) log(`delivered report stale (wake ${String(wakeId).slice(0, 8)} superseded) — ok`)
    }
  } catch { /* best-effort */ }
}

// ── Debounced nudge ─────────────────────────────────────────────────────────
let pending = [] // collected events in the current burst
let timer = null
let flushing = false // single-flight guard: only one flush() runs at a time
let retries = 0      // consecutive transient-failure count -> backoff level
const RETRY_MAX_MS = 30_000 // backoff cap; keep retrying for the session, never drop a live wake
// messageIds seen on the live SSE stream. Role reduced under 07: the authoritative
// coalescing is now the server-side wake state machine + per-part lease, and

function enqueue(evt) {
  pending.push(evt)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE_MS)
}

// Re-queue a batch we COULD NOT deliver for a transient reason (server unreachable,
// agent temporarily a bare shell, tmux send failed). Retrying with capped backoff -
// never dropping - because the server's eligibility sweep excludes agents that still
// have an active wake, so a dropped wake strands until it stale-expires. Definitive
// outcomes (noWake / lease held by another pager) are dropped by the caller instead.
function requeue(batch, reason) {
  pending.unshift(...batch)
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(retries, 6))
  retries++
  if (!timer) timer = setTimeout(flush, delay)
  log(`nudge deferred: ${reason} (retry #${retries} in ${delay}ms)`)
}

// Interpret a claimLease() result. Returns:
//   { go: false, reason }   -> do not nudge (no wake / held by other / lost / unreachable)
//   { go: true, wakeId }    -> we hold the lease; nudge for this wakeId
// Also syncs the global leaseHeld so heartbeats and re-claims agree.
// FAIL-CLOSED: a null lease means the claim endpoint was unreachable, so we have NOT
// confirmed we hold the lease. Skip rather than nudge on a guess - the server's
// eligibility sweep re-issues the wake once the server is reachable again, so no
// wake is lost; this only avoids a stale/unauthorized nudge during an outage.
function leaseDecision(lease) {
  // TRANSIENT: server unreachable. flush() re-queues on transient so the wake isn't
  // dropped during an outage (the channel server does the same). Without this flag,
  // requeue() never fires and the backoff retry path is dead code.
  if (!lease) return { go: false, reason: "claim unreachable", transient: true }
  if (lease.noWake) return { go: false, reason: "no active wake" }
  if (lease.held && lease.holder !== HOLDER) return { go: false, reason: `lease held by ${lease.holder}` }
  leaseHeld = !!lease.ok
  if (!lease.ok) return { go: false, reason: "lease not held" }
  // The server returns wakeId on EVERY ok:true claim (wake-lease.ts). A missing one
  // means a server-side inconsistency: fail-closed rather than report a guessed
  // (possibly stale) token - the eligibility sweep re-issues, so no wake is lost.
  if (!lease.wakeId) return { go: false, reason: "claim ok but no wakeId" }
  return { go: true, wakeId: lease.wakeId }
}

// Wording matters: telling the agent to "reply" makes it answer every message
// (incl. acks), which wakes the sender back -> an endless ack-of-ack loop that
// burns tokens. Instead: read, reply ONLY if an answer is needed, and `ack`
// when handled. Empty subject/sender are omitted (no ugly ""/? ).
function buildText(batch, wakeId) {
  const guidance = `Use the RelayRoom \`inbox\` MCP tool to read (NOT curl/shell - the HTTP API 404s and won't mark anything read). Reply ONLY if it needs an answer; otherwise just ack it. Do NOT reply to acknowledge or confirm. Close the thread when it's resolved.`
  const wakeTag = wakeId ? ` (wake ${String(wakeId).slice(0, 8)})` : ""
  if (batch.length === 1) {
    const e = batch[0]
    const subj = e.subject ? ` "${e.subject}"` : ""
    const who = e.fromPart ? ` from ${e.fromPart}` : ""
    return `📬 RelayRoom: new message${subj}${who} (you are part "${PART}"). ${guidance}${wakeTag}`
  }
  const froms = [...new Set(batch.map((e) => e.fromPart).filter(Boolean))].join(", ")
  return `📬 RelayRoom: ${batch.length} new messages for part "${PART}"${froms ? ` (from ${froms})` : ""}. ${guidance}${wakeTag}`
}

// Single-flight + drain. Concurrent enqueues during a slow flush (defer can wait
// minutes) used to spawn overlapping flushes that raced on currentWakeId and the
// lease. Now: one flush runs; anything enqueued meanwhile is drained in the same
// loop. wakeId is captured LOCALLY per batch so a heartbeat/SSE update mid-defer
// can't redirect reportDelivered to the wrong wake.
async function flush() {
  timer = null
  if (flushing) return // a flush is already draining; it will pick up new pending
  flushing = true
  try {
    while (pending.length > 0) {
      const batch = pending
      pending = []

      // 1) Claim the per-part lease: the server decides who nudges. (We re-claim
      //    after the defer below, so the wakeId we actually use is captured THERE.)
      const first = leaseDecision(await claimLease())
      if (!first.go) {
        // Transient (server unreachable) -> re-queue+backoff; definitive -> drop.
        if (first.transient) { requeue(batch, first.reason); break }
        retries = 0; log(`skip nudge: ${first.reason}`); continue
      }

      // 2) Don't type into a bare shell (agent exited). Re-queue (the agent usually
      //    comes back); the active wake won't be re-issued by the sweep meanwhile.
      if (!(await agentPresent())) { requeue(batch, "target is a bare shell (agent exited)"); break }

      // 3) Hold until the pane is quiet (no active typing / streaming / copy-mode).
      //    This can wait up to DEFER_MAX_MS, so the lease/wake/agent may change.
      await waitUntilQuiet()

      // 4) Re-validate the lease AFTER the defer: if the wake was settled (caught up)
      //    or another pager took the part while we waited, do NOT inject a stale nudge.
      //    leaseDecision guarantees a concrete wakeId when go=true, so the wake we
      //    announce is always the CURRENT one - its pending messages still need
      //    reading even if it rolled over while we waited. wakeId from the re-claim
      //    is used for both the text tag and reportDelivered, so they always match.
      const again = leaseDecision(await claimLease())
      if (!again.go) {
        if (again.transient) { requeue(batch, again.reason); break }
        retries = 0; log(`skip nudge after defer: ${again.reason}`); continue
      }
      const wakeId = again.wakeId

      // 5) The agent may have exited DURING the defer - re-check before injecting so
      //    we never type a nudge into a bare shell.
      if (!(await agentPresent())) { requeue(batch, "agent exited during defer"); break }

      // 6) Deliver, then fence the wake pending -> delivered with the re-claimed wakeId.
      const ok = await sendKeysOnce(buildText(batch, wakeId))
      if (ok) {
        retries = 0
        log(`nudged ${TARGET}: ${batch.length} msg`)
        await reportDelivered(wakeId)
      } else {
        // tmux send failed after its own retries -> transient; re-queue with backoff.
        requeue(batch, "send-keys failed"); break
      }
    }
  } finally {
    flushing = false
  }
}

// ── SSE subscription (manual parse over fetch stream) ───────────────────────
function sseUrl() {
  const u = new URL(`${SERVER}/api/sse`)
  if (CODE) u.searchParams.set("code", CODE)
  else u.searchParams.set("project", PROJECT)
  u.searchParams.set("part", PART)
  return u.toString()
}

// Idle watchdog: the server sends a keepalive ping every ~15s. If NOTHING arrives
// for this long the connection is half-open (silently dead); abort so the reconnect
// loop re-establishes it instead of blocking forever in reader.read().
const SSE_IDLE_MS = 45_000

async function subscribe() {
  const headers = { accept: "text/event-stream" }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`

  const ctrl = new AbortController()
  const res = await fetch(sseUrl(), { headers, signal: ctrl.signal })
  if (!res.ok || !res.body) {
    throw new Error(`SSE ${res.status} ${res.statusText}`)
  }
  log(`connected → ${sseUrl()}`)
  // The live stream only carries messages that arrive while we're connected.
  // Pull anything we missed during the gap before this connection.
  void catchUp()

  // Arm/re-arm the idle watchdog on every byte; fire => abort the stream.
  let idle = setTimeout(() => ctrl.abort(), SSE_IDLE_MS)
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), SSE_IDLE_MS) }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let eventName = "message"
  let dataLines = [] // per SSE spec, an event may span MULTIPLE data: lines, joined by \n

  // Dispatch one fully-accumulated event (fired on the blank line that ends it).
  const dispatchEvent = () => {
    if (dataLines.length && eventName === "message") {
      try {
        const evt = JSON.parse(dataLines.join("\n"))
        // The bus 'message' stream also carries presence events (kind:'pager',
        // emitted by every heartbeat) which the web uses for live status. Those have
        // no subject/sender; if we treated them as messages, each heartbeat would
        // enqueue an empty "message" and, during an active wake, fire an extra nudge
        // -> a self-inflicted nudge storm. Only react to real messages.
        if (evt.part === PART && evt.kind === "message") {
          log(`event: "${evt.subject ?? ""}" from ${evt.fromPart ?? "?"}`)
          enqueue(evt)
        }
      } catch {
        // non-JSON data (e.g. ping payloads) — ignore
      }
    }
    eventName = "message"
    dataLines = []
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bump() // got bytes -> connection is alive, re-arm the idle watchdog
      buf += decoder.decode(value, { stream: true })

      let idx
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "")
        buf = buf.slice(idx + 1)

        if (line === "") { dispatchEvent(); continue } // blank line ends the event
        if (line.startsWith(":")) continue // comment / keepalive ping
        if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue }
        if (line.startsWith("data:")) {
          // Strip ONE leading space after the colon (SSE spec), keep the rest verbatim.
          dataLines.push(line.slice(5).replace(/^ /, ""))
        }
      }
    }
  } finally {
    clearTimeout(idle) // stop the watchdog whether we ended cleanly or via abort
  }
}

// ── Reconnect loop ───────────────────────────────────────────────────────────
// Heartbeat: keep the agent's last-seen fresh on the dashboard and report
// whether RELAYROOM.md is present in the worktree. Connect-code only (the legacy
// project-slug path has no heartbeat endpoint). Best-effort; never throws.
async function heartbeat() {
  if (!CODE) return
  try {
    const res = await fetch(`${SERVER}/mcp/${encodeURIComponent(CODE)}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ part: PART, holder: HOLDER, host: hostname(), relayroomMd: existsSync(join(DIR, "RELAYROOM.md")) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.ok) {
      const json = await res.json().catch(() => ({}))
      // leaseHeld:false => another pager took over; stop nudging until next claim.
      if (typeof json.leaseHeld === "boolean") leaseHeld = json.leaseHeld
      // The agent's dashboard color (hex): cache it (on change) and paint this
      // session's tmux status bar with it, picking a readable black/white text
      // color from luminance (tmux does not auto-invert). Re-applied each beat so a
      // freshly recreated session gets recolored.
      if (typeof json.color === "string" && /^#[0-9a-fA-F]{6}$/.test(json.color)) {
        if (json.color !== lastColor) {
          try { writeFileSync(join(DIR, ".relayroom", "color"), json.color) } catch { /* ignore */ }
          lastColor = json.color
        }
        if (TARGET) {
          // Timeout like every other tmux call - a hung set-option on each heartbeat
          // would otherwise pile up zombie children forever.
          execFile("tmux", ["set-option", "-t", TARGET, "status-style", `bg=${json.color},fg=${contrastOn(json.color)}`], { timeout: TMUX_TIMEOUT_MS }, () => {})
        }
      }
    }
  } catch { /* best-effort */ }
}
let lastColor = ""

// ── Reconnect catch-up ───────────────────────────────────────────────────────
// On every successful (re)connect, ask the server for a SINGLE coalesced wake
// decision for this part (07). The server decides — given the active wake state +
// unread + budget — whether to wake this idle part ONCE. This replaces the old
// per-unread-item nudging: the messages stay in the inbox; catch-up only decides
// whether to wake the part a single time. Connect-code only; best-effort.
// Coalesce repeated catch-ups for the SAME wake. SSE can reconnect in bursts, and
// each reconnect runs catchUp(); without this an unstable connection re-nudges the
// same wakeId over and over. The server settles the wake once the agent reads/acks
// (then pending-wake returns wake:false), so this only smooths the pre-settle window.
let lastCatchupWakeId = null
let lastCatchupAt = 0
const CATCHUP_COOLDOWN_MS = 30_000

async function catchUp() {
  if (!CODE) return
  try {
    const u = new URL(`${SERVER}/mcp/${encodeURIComponent(CODE)}/pending-wake`)
    u.searchParams.set("part", PART)
    u.searchParams.set("holder", HOLDER)
    // Timeout: every reconnect runs catchUp(); without a cap a hung request would
    // accumulate and never resolve on a half-open connection.
    const res = await fetch(u, { headers: authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return
    const d = await res.json()
    if (!d.wake) {
      if (d.suppressed) log("catch-up: budget-suppressed, sweep will recover")
      return
    }
    const nowTs = Date.now()
    if (d.wakeId === lastCatchupWakeId && nowTs - lastCatchupAt < CATCHUP_COOLDOWN_MS) {
      return // same wake, just re-delivered on a reconnect - don't re-nudge yet
    }
    lastCatchupWakeId = d.wakeId
    lastCatchupAt = nowTs
    // Single coalesced wake — never per-unread-item.
    enqueue({ subject: d.subject, fromPart: d.fromPart, messageId: d.wakeId, count: d.count })
    log(`catch-up: 1 coalesced wake (${d.count ?? "?"} unread)`)
  } catch (err) {
    log("catch-up failed:", err.message)
  }
}

async function main() {
  heartbeat()
  setInterval(heartbeat, HEARTBEAT_MS)
  // Channel delivery: a Claude Channels server owns wakes. Keep heartbeat/statusline
  // alive but do NOT subscribe or send-keys, so the agent is never double-woken.
  if (DELIVERY === "channel") {
    log(`delivery=channel for part=${PART} → wakes via Claude Channels; pager runs heartbeat/statusline only`)
    return
  }
  log(`watching ${CODE ? `code=${CODE}` : `project=${PROJECT}`} part=${PART} → tmux ${TARGET} (server ${SERVER})`)
  for (;;) {
    try {
      await subscribe()
      log("stream ended; reconnecting in 2s")
    } catch (err) {
      log("stream error:", err.message, "— retry in 2s")
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

main()
