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
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { basename, join } from "node:path"
// Nudge text builder + keystroke sanitizer live in a side-effect-free module so they
// are unit-testable and so peer/server-controlled subject/fromPart can never carry a
// control byte (e.g. \r => Enter) into `tmux send-keys -l`. See pager-text.mjs.
import { buildText } from "./pager-text.mjs"
// Headless delivery (delivery=headless, codex/agy only): spawn the part's CLI per wake
// instead of tmux send-keys. Pure spec/prompt builders live in a testable sibling module.
import { buildHeadlessPrompt, headlessSpawnSpec, makeWakeDedup } from "./pager-headless.mjs"
// The wake protocol (lease claim, fencing, SSE, catch-up) is shared with the Claude
// Channels server; only the delivery below is send-keys / headless specific.
import { createWakeClient, backoff } from "./wake-client.mjs"

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
// Our own CLI version (from the package we ship inside), reported on each
// heartbeat so the hub can tell us whether a newer CLI is on npm.
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || null }
  catch { return null }
})()
const DEBOUNCE_MS = Number(arg("debounce", "1200"))
// Bearer token: needed for /api/sse auth AND, under headless delivery, injected into the
// codex child env (RELAYROOM_TOKEN). Fall back to config.json so a bare `pager` start
// (no --token flag) still authenticates a headless spawn.
const TOKEN = arg("token", CFG.token)
const DIR = arg("dir", process.cwd()) // worktree dir; used to detect RELAYROOM.md
const HEARTBEAT_MS = 30000
// Wake delivery path (set by rr.sh). "channel" => a Claude Code Channels server
// pushes wakes; the pager must NOT also send-keys (double-wake). Under "channel" the
// pager runs heartbeat/statusline/presence only and skips SSE + flush entirely.
// "headless" => spawn the part's CLI (codex/agy) per wake instead of tmux send-keys;
// the pager keeps SSE + lease + heartbeat but the delivery step is a process spawn.
const DELIVERY = arg("delivery", CFG.delivery ?? "pager")
const HEADLESS = DELIVERY === "headless"
// The CLI to spawn under headless delivery (config.agent's primary entry). codex/agy only.
const AGENT_CLI = arg("agent-cli", String(CFG.agent ?? "").split(",")[0].trim())
// Cap one headless wake so a hung/looping child can't pin the single-flight flush forever.
const HEADLESS_TIMEOUT_MS = (() => {
  const n = Math.floor(Number(arg("headless-timeout", "180000")))
  return Number.isFinite(n) ? Math.min(600_000, Math.max(10_000, n)) : 180_000
})()
// K: send-keys retries after the first fire. Clamp to a finite [0, 8] so a bad
// --retries (NaN, negative, or Infinity) can't turn retryTmux into an unbounded loop.
const RETRY_MAX = (() => {
  const n = Math.floor(Number(arg("retries", "3")))
  return Number.isFinite(n) ? Math.min(8, Math.max(0, n)) : 3
})()
const RETRY_BASE_MS = 500                      // backoff base
// Settle delay between the literal text and the submitting Enter. codex/gemini TUIs run
// paste/burst detection: an Enter that arrives in the SAME fast keystroke burst as the
// text is folded into the composer as a newline, NOT treated as a submit - so the nudge
// lands in the input box but is never sent until a human presses Enter. Waiting a beat
// makes the Enter a distinct keypress the TUI submits. Tunable via --submit-delay (ms)
// for a slow TUI/host; clamped to [0, 3000], 0 disables. claude's Channels path bypasses
// send-keys entirely, so this only affects the send-keys agents.
const SUBMIT_DELAY_MS = (() => {
  const n = Math.floor(Number(arg("submit-delay", "300")))
  return Number.isFinite(n) ? Math.min(3000, Math.max(0, n)) : 300
})()

// CODE (connect code) is REQUIRED: the lease/wake/heartbeat endpoints are all
// connect-code keyed. A --project-only (legacy slug) start can subscribe to SSE but
// can never claim a lease, so it would fail-closed forever (or, with the backoff
// re-queue, spin). Require CODE so that can't happen.
// TARGET is required for the tmux paths (pager/channel) but NOT for headless, which
// spawns a CLI instead of typing into a pane. Headless instead needs a supported AGENT_CLI.
if (!CODE || !PART || (!HEADLESS && !TARGET)) {
  console.error("usage: node relayroom-pager.mjs --code <connect_code> --part <part> --target <tmux-target> [--server url] [--debounce ms] [--token bearer] [--retries K]")
  process.exit(1)
}
if (HEADLESS && !headlessSpawnSpec(AGENT_CLI, {})) {
  // headlessSpawnSpec returns null for claude/unknown; fail loud at startup rather than
  // re-queueing every wake forever with an "unsupported CLI" that can never succeed.
  console.error(`relayroom-pager: delivery=headless needs --agent-cli codex|agy (got "${AGENT_CLI || "none"}")`)
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

// Cap every server fetch: a hung claim/delivered call inside flush() would otherwise
// pin the single-flight `flushing` flag true forever and stall all later nudges.
// Declared here rather than with the tmux timeouts below because the wake client
// reads it at module init, and a `const` read before its declaration is a crash.
const FETCH_TIMEOUT_MS = 8000

const wake = createWakeClient({
  server: SERVER,
  code: CODE,
  project: PROJECT,
  part: PART,
  holder: HOLDER,
  token: TOKEN,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  log,
})

let activeHeadlessChild = null

function killHeadlessChild(child = activeHeadlessChild, signal = "SIGTERM", force = false) {
  if (!child || !child.pid || (child.killed && !force)) return
  try {
    // Headless CLIs may spawn helper/model/MCP children. On Unix, detached:true below
    // makes the CLI a process-group leader, so negative pid kills the whole group.
    if (process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch { /* ignore */ }
  }
}

// Best-effort lease release on shutdown. fire-and-forget (cannot await in a
// signal handler); the server lease TTL backstops a dropped call.
const releaseLease = () => {
  if (!CODE) return
  fetch(`${SERVER}/mcp/${encodeURIComponent(CODE)}/heartbeat`, {
    method: "POST",
    headers: wake.authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ part: PART, holder: HOLDER, release: true }),
  }).catch(() => {})
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killHeadlessChild(activeHeadlessChild, sig); releaseLease(); process.exit(0) })

// ── tmux nudge ──────────────────────────────────────────────────────────────
const TMUX_TIMEOUT_MS = 5000 // kill a hung tmux child so the defer loop can't wait forever

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

// Command names of every descendant process of `rootPid` (best-effort, null if ps
// is unavailable). `comm` may be a full path on macOS, so callers basename() it.
function psDescendantComms(rootPid) {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,comm="], { timeout: TMUX_TIMEOUT_MS }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return }
      const kids = new Map()   // ppid -> [pid]
      const comm = new Map()   // pid -> command
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!m) continue
        comm.set(m[1], m[3].trim())
        const arr = kids.get(m[2]) ?? []
        arr.push(m[1]); kids.set(m[2], arr)
      }
      const out = []
      const seen = new Set()
      const stack = [String(rootPid)]
      while (stack.length) {
        const p = stack.pop()
        for (const c of kids.get(p) ?? []) {
          if (seen.has(c)) continue
          seen.add(c)
          out.push(comm.get(c) ?? "")
          stack.push(c)
        }
      }
      resolve(out)
    })
  })
}

async function agentPresent() {
  const pid = await tmuxCapture(["display-message", "-p", "-t", TARGET, "#{pane_pid}"])
  if (!pid.ok || !pid.out.trim()) return true // can't tell - don't block on uncertainty
  // The default `up` launches the agent as `sh -c "<resume> || <fresh>"`, so the
  // pane's FOREGROUND command is a shell while the real agent (claude/codex/agy and
  // its node MCP children) runs as a DESCENDANT. Checking only pane_current_command
  // falsely reports "agent exited" for every resume-launched send-keys agent and
  // defers its wakes forever. The agent is present iff the pane's process subtree
  // holds any non-shell process.
  const comms = await psDescendantComms(pid.out.trim())
  // ps unavailable: we cannot inspect the subtree, so fail OPEN (deliver). Falling
  // back to the pane_current_command check would re-introduce the very bug this
  // fixes - a shell-wrapped agent looks like a bare shell.
  if (comms === null) return true
  return comms.some((c) => c && !SHELL_COMMANDS.has(basename(c)))
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
  // Let the TUI finish ingesting the literal text before the Enter, so codex/gemini
  // paste-burst detection doesn't fold the Enter into the composer as a newline (which
  // leaves the nudge sitting unsent in the input box). See SUBMIT_DELAY_MS. Kept on the
  // SAME retry-separated step as before: the text is already in, so we only (re)send Enter.
  if (SUBMIT_DELAY_MS > 0) await sleep(SUBMIT_DELAY_MS)
  return await retryTmux(["send-keys", "-t", TARGET, "Enter"])
}

// ── Headless delivery (codex/agy) ─────────────────────────────────────────────
// Instead of typing into a tmux pane, spawn the part's CLI once for this wake so it
// reads/handles its inbox via the RelayRoom MCP tools and exits. Subscription-covered
// (codex ChatGPT auth / agy Google plan), no send-keys, no interactive session. Resolves
// true on a clean exit (fence the wake), false on spawn/exec failure or timeout (re-queue).
function spawnHeadless(batch, wakeId) {
  const spec = headlessSpawnSpec(AGENT_CLI, { token: TOKEN, prompt: buildHeadlessPrompt(batch, wakeId, PART) })
  if (!spec) { log(`headless: unsupported agent CLI "${AGENT_CLI}"`); return Promise.resolve(false) }
  return new Promise((resolve) => {
    // execFile (no shell) so the prompt is a single argv element - never re-parsed by a
    // shell, so nothing in it can inject a command. Merge only the token into the child env.
    let timedOut = false
    const child = execFile(spec.command, spec.args, {
      detached: process.platform !== "win32",
      env: { ...process.env, ...spec.env },
      maxBuffer: 16 * 1024 * 1024, // codex --json / agy output can be chatty; don't EPIPE
    }, (err) => {
      clearTimeout(timeout)
      if (activeHeadlessChild === child) activeHeadlessChild = null
      if (err) {
        killHeadlessChild(child, "SIGTERM", true)
        log(`headless ${spec.command} failed:`, timedOut ? `timed out after ${HEADLESS_TIMEOUT_MS}ms` : err.message)
        resolve(false)
      }
      else resolve(true)
    })
    activeHeadlessChild = child
    const timeout = setTimeout(() => {
      timedOut = true
      killHeadlessChild(child, "SIGTERM")
      setTimeout(() => killHeadlessChild(child, "SIGKILL", true), 5000).unref()
    }, HEADLESS_TIMEOUT_MS)
    timeout.unref()
  })
}

// ── Debounced nudge ─────────────────────────────────────────────────────────
let pending = [] // collected events in the current burst
let timer = null
let flushing = false // single-flight guard: only one flush() runs at a time
let retries = 0      // consecutive transient-failure count -> backoff level
const RETRY_MAX_MS = 30_000 // backoff cap; keep retrying for the session, never drop a live wake

// Headless de-dup: wakeIds we have already spawned a CLI for, so a sweep-re-issued
// (un-acked) wake never triggers a second expensive model run. See makeWakeDedup.
const headlessDedup = makeWakeDedup()

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
  const delay = backoff(retries, { baseMs: RETRY_BASE_MS, capMs: RETRY_MAX_MS, maxExponent: 6 })
  retries++
  if (!timer) timer = setTimeout(flush, delay)
  log(`nudge deferred: ${reason} (retry #${retries} in ${delay}ms)`)
}

// buildText now lives in pager-text.mjs (imported above) so the keystroke sanitizer is
// unit-testable and applied to every peer/server-controlled field.

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
      const first = wake.leaseDecision(await wake.claimLease())
      if (typeof first.held === "boolean") leaseHeld = first.held
      if (!first.go) {
        // Transient (server unreachable) -> re-queue+backoff; definitive -> drop.
        if (first.transient) { requeue(batch, first.reason); break }
        retries = 0; log(`skip nudge: ${first.reason}`); continue
      }

      // Headless delivery: no tmux pane, so skip agentPresent/defer/re-claim entirely.
      // There is no defer window, so first.wakeId is the current wake - spawn the CLI,
      // then fence pending -> delivered. Failure (spawn/exec/timeout) re-queues with backoff.
      if (HEADLESS) {
        // Spawn a full CLI run at most ONCE per wakeId. reportDelivered fences the wake
        // pending -> delivered, but the server keeps re-issuing a wake until the AGENT acks
        // it; if the spawned codex/agy read the inbox but did not ack (e.g. it decided not
        // to reply), every SSE reconnect/catch-up would re-claim the SAME wakeId and spawn
        // another expensive model run - an unbounded quota-burning loop. Send-keys re-nudges
        // cheaply, but a headless re-spawn is not cheap, so we de-dup here. A genuinely new
        // message settles the old wake and issues a NEW wakeId (rollover), which passes.
        if (headlessDedup.has(first.wakeId)) {
          retries = 0
          log(`headless: wake ${String(first.wakeId).slice(0, 8)} already delivered - not re-spawning`)
          continue
        }
        const ok = await spawnHeadless(batch, first.wakeId)
        if (ok) {
          retries = 0
          headlessDedup.mark(first.wakeId)
          log(`headless delivered via ${AGENT_CLI}: ${batch.length} message(s)`)
          await wake.reportDelivered(first.wakeId)
        } else {
          requeue(batch, "headless spawn failed"); break
        }
        continue
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
      const again = wake.leaseDecision(await wake.claimLease())
      if (typeof again.held === "boolean") leaseHeld = again.held
      if (!again.go) {
        if (again.transient) { requeue(batch, again.reason); break }
        retries = 0; log(`skip nudge after defer: ${again.reason}`); continue
      }
      const wakeId = again.wakeId

      // 5) The agent may have exited DURING the defer - re-check before injecting so
      //    we never type a nudge into a bare shell.
      if (!(await agentPresent())) { requeue(batch, "agent exited during defer"); break }

      // 6) Deliver, then fence the wake pending -> delivered with the re-claimed wakeId.
      const ok = await sendKeysOnce(buildText(batch, wakeId, PART))
      if (ok) {
        retries = 0
        log(`nudged ${TARGET}: ${batch.length} msg`)
        await wake.reportDelivered(wakeId)
      } else {
        // tmux send failed after its own retries -> transient; re-queue with backoff.
        requeue(batch, "send-keys failed"); break
      }
    }
  } finally {
    flushing = false
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
      headers: wake.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ part: PART, holder: HOLDER, host: hostname(), relayroomMd: existsSync(join(DIR, "RELAYROOM.md")), version: VERSION }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    // A rejected heartbeat is silent otherwise: presence, the status color, the lease
    // state and the update marker all just stop updating. Log it, but only when the
    // status CHANGES - this runs every 30s, and a hub that is down would otherwise
    // fill the log with the same line.
    if (!res.ok && res.status !== lastHeartbeatStatus) {
      log(`heartbeat rejected: ${res.status}${res.status === 401 || res.status === 403 ? " (token missing or expired - re-run ./rr.sh setup)" : ""}`)
    }
    if (res.ok && lastHeartbeatStatus !== 200) log("heartbeat ok again")
    lastHeartbeatStatus = res.status
    if (res.ok) {
      const json = await res.json().catch(() => ({}))
      // leaseHeld:false => another pager took over; stop nudging until next claim.
      if (typeof json.leaseHeld === "boolean") leaseHeld = json.leaseHeld
      // CLI update nudge: persist the latest npm version (or clear it) so rr.sh's
      // status line can show a `↑<ver>` marker. The hub decides updateAvailable by
      // comparing our reported version against npm.
      try {
        const f = join(DIR, ".relayroom", ".update")
        if (json.updateAvailable === true && typeof json.latestCli === "string") writeFileSync(f, json.latestCli)
        else if (existsSync(f)) unlinkSync(f)
      } catch { /* ignore */ }
      // Cache this agent's role (main|default) so the Claude AskUserQuestion guard
      // can tell whether it may ask the human (main) or must route to main (default).
      try {
        if (typeof json.role === "string") {
          // Atomic write (temp + rename) so the guard never reads a half-written file.
          const rf = join(DIR, ".relayroom", ".role")
          writeFileSync(rf + ".tmp", json.role)
          renameSync(rf + ".tmp", rf)
        }
      } catch { /* ignore */ }
      // The agent's dashboard color (hex): cache it (on change) and paint this
      // session's tmux status bar with it, picking a readable black/white text
      // color from luminance (tmux does not auto-invert). Re-applied each beat so a
      // freshly recreated session gets recolored.
      if (typeof json.color === "string" && /^#[0-9a-fA-F]{6}$/.test(json.color)) {
        if (json.color !== lastColor) {
          try { writeFileSync(join(DIR, ".relayroom", "color"), json.color) } catch { /* ignore */ }
          lastColor = json.color
        }
        if (TARGET && !HEADLESS) {
          // Timeout like every other tmux call - a hung set-option on each heartbeat
          // would otherwise pile up zombie children forever. (truecolor + status-right
          // content are wired once in setupStatusBar; here we only repaint the color.)
          // Headless has no tmux pane, so never paint (a stale config target could exist).
          execFile("tmux", ["set-option", "-t", TARGET, "status-style", `bg=${json.color},fg=${contrastOn(json.color)}`], { timeout: TMUX_TIMEOUT_MS }, () => {})
        }
      }
    }
  } catch { /* best-effort */ }
}
let lastColor = ""
// Last HTTP status the heartbeat saw, so a persistent failure logs once rather than
// every 30s. Starts at 200 so a healthy first beat says nothing.
let lastHeartbeatStatus = 200

// One-time tmux status-bar wiring for this session. The agent ships an `rr.sh
// statusline` subcommand that prints "<part> | inbox: N | ● MCP | ● Pager", but
// nothing else points tmux at it - so without this the bar shows tmux's default
// content (or nothing useful). We set it session-local (-t TARGET) so we never
// touch the user's global tmux config. We also enable truecolor: the heartbeat
// paints the bar with the agent's 24-bit hex color, which tmux only renders true
// when it knows the terminal does RGB - on terminals whose TERM resolves to a low
// color count (e.g. plain `xterm` = 8 colors, common on Linux) the hex would
// otherwise be crushed to the nearest ANSI shade. `-ga` appends so we never
// clobber the user's own terminal-overrides.
function setupStatusBar() {
  if (!TARGET) return
  const set = (...a) => execFile("tmux", a, { timeout: TMUX_TIMEOUT_MS }, () => {})
  set("set-option", "-ga", "terminal-overrides", ",*:Tc")
  set("set-option", "-t", TARGET, "status-right",
    "#(cd '#{pane_current_path}' 2>/dev/null && [ -x ./rr.sh ] && ./rr.sh statusline 2>/dev/null) #[fg=colour240]│#[fg=colour244] %H:%M ")
  set("set-option", "-t", TARGET, "status-right-length", "80")
  // tmux's default status-left-length is 10, which truncates the default
  // "[#{session_name}] " mid-name for RelayRoom sessions (e.g. the standard
  // "RR-<project-slug>-<part>" name -> "[RR-digita" with no closing bracket,
  // running into the window list). Widen it so the session name and its bracket
  // always render in full (60 covers a 32-char slug + "RR-" + "-<part>").
  set("set-option", "-t", TARGET, "status-left-length", "60")
  set("set-option", "-t", TARGET, "status-interval", "5")
}

async function main() {
  // Headless delivery has no tmux pane, so skip status-bar wiring; heartbeat still runs
  // (it is the presence signal for a headless part, and skips its own tmux paint below).
  if (!HEADLESS) setupStatusBar()
  heartbeat()
  setInterval(heartbeat, HEARTBEAT_MS)
  // Channel delivery: a Claude Channels server owns wakes. Keep heartbeat/statusline
  // alive but do NOT subscribe or send-keys, so the agent is never double-woken.
  if (DELIVERY === "channel") {
    log(`delivery=channel for part=${PART} → wakes via Claude Channels; pager runs heartbeat/statusline only`)
    return
  }
  if (HEADLESS) {
    log(`delivery=headless for part=${PART} → wakes spawn \`${AGENT_CLI}\` (server ${SERVER}); no tmux/send-keys`)
  } else {
    log(`watching ${CODE ? `code=${CODE}` : `project=${PROJECT}`} part=${PART} → tmux ${TARGET} (server ${SERVER})`)
  }
  for (;;) {
    try {
      // The live stream only carries what arrives while connected, so catch-up runs on
      // every (re)connect to pick up whatever landed during the gap.
      await wake.subscribe({ onMessage: enqueue, onConnect: () => void wake.catchUp({ enqueue }) })
      log("stream ended; reconnecting in 2s")
    } catch (err) {
      log("stream error:", err.message, "— retry in 2s")
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

main()
