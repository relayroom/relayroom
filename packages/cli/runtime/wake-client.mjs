/**
 * The wake protocol, shared by the pager and the Claude Channels server.
 *
 * Both of them talk to the same server-side wake state machine: subscribe to the
 * part's SSE stream, claim the per-part lease, deliver, then fence the wake as
 * delivered. Only the DELIVERY differs - the pager types into a tmux pane (or spawns
 * a CLI headless), the channel server pushes an MCP notification. Everything up to
 * that point was duplicated, and had begun to drift: one reported a stale wake and
 * the other silently ignored the response, one wrote a module-level flag from inside
 * a decision function, and their retry curves differed by 4x for no recorded reason.
 *
 * This module is that shared half, as a factory: every call needs the same five
 * connection values, so passing them per-call is just a wider surface to get wrong.
 * It is side-effect free on import - no argv parsing, no process.exit, no timers
 * started - which is what makes it directly testable, the same way pager-text.mjs
 * and pager-headless.mjs already are.
 *
 * What deliberately stays OUT: each consumer's flush(). They look alike but the
 * pager's carries defer-until-quiet, an agent-present check, a post-defer re-claim
 * and a headless branch. Merging them would add conditionals to the one path whose
 * failure mode is silent (the agent simply never wakes), which is the opposite of
 * what this refactor is for.
 */

/** Default per-request cap. A hung call here stalls the caller's single-flight flush. */
const DEFAULT_FETCH_TIMEOUT_MS = 8000
/** The server pings about every 15s; no bytes for this long means a half-open socket. */
const DEFAULT_SSE_IDLE_MS = 45_000
/** Repeated catch-ups for the SAME wake are pointless; SSE can reconnect in bursts. */
const CATCHUP_COOLDOWN_MS = 30_000

/**
 * Exponential backoff with a ceiling, shared so both consumers retry on one curve.
 * `attempt` is 0-based. The exponent is capped as well as the result: without that,
 * a long outage grows 2**attempt until it overflows to Infinity, and `Math.min` on
 * Infinity happens to be right only by accident.
 */
export function backoff(attempt, { baseMs = 500, capMs = 30_000, maxExponent = 6 } = {}) {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  return Math.min(capMs, baseMs * 2 ** Math.min(n, maxExponent))
}

/**
 * Interpret a `wake/claim` response.
 *
 * Pure on purpose: the pager used to assign a module-level `leaseHeld` from inside
 * this function while the channel server did not, so the two disagreed about what a
 * claim even means. The lease state comes back as `held` and the caller assigns it.
 *
 * FAIL-CLOSED. A null lease means the claim never reached the server, so we have NOT
 * confirmed we hold it - skip rather than nudge on a guess. `transient: true` marks
 * that case as worth retrying: the server's eligibility sweep re-issues the wake once
 * it is reachable again, so nothing is lost by waiting, and a wake dropped for good
 * strands the agent until the wake stale-expires.
 */
export function leaseDecision(lease, holder) {
  if (!lease) return { go: false, reason: "claim unreachable", transient: true }
  if (lease.noWake) return { go: false, reason: "no active wake" }
  // Another pager (or the channel server) owns this part's wake. `held` is left
  // undefined so the caller keeps whatever lease state it already had, matching the
  // pager's original behavior of not touching its flag on this branch.
  if (lease.held && lease.holder !== holder) return { go: false, reason: `lease held by ${lease.holder}` }
  if (!lease.ok) return { go: false, reason: "lease not held", held: false }
  // The server returns a wakeId on EVERY ok:true claim. A missing one is a server-side
  // inconsistency: fail closed rather than fence a guessed (possibly stale) token.
  if (!lease.wakeId) return { go: false, reason: "claim ok but no wakeId", held: true }
  return { go: true, wakeId: lease.wakeId, held: true }
}

/**
 * One connected wake client. `log` is the consumer's logger (the pager writes to
 * stdout, the channel server MUST write to stderr because stdout is its MCP
 * transport), so this module never picks a stream itself.
 */
export function createWakeClient({
  server,
  code,
  project,
  part,
  holder,
  token,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  log = () => {},
}) {
  const base = `${server}/mcp/${encodeURIComponent(code ?? "")}`

  /** Bearer when the worktree has one. Never an empty `Bearer `: the server treats a
   *  present-but-invalid credential as invalid rather than falling back. */
  function authHeaders(extra) {
    const h = { ...(extra ?? {}) }
    if (token) h.authorization = `Bearer ${token}`
    return h
  }

  function sseUrl() {
    const u = new URL(`${server}/api/sse`)
    if (code) u.searchParams.set("code", code)
    else u.searchParams.set("project", project)
    u.searchParams.set("part", part)
    return u.toString()
  }

  /** Claim this part's active wake. Returns the response JSON, or null if the claim
   *  never completed (transport failure, timeout, non-2xx). */
  async function claimLease() {
    if (!code) return null
    try {
      const res = await fetch(`${base}/wake/claim`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ part, holder }),
        signal: AbortSignal.timeout(fetchTimeoutMs),
      })
      if (!res.ok) return null
      return await res.json()
    } catch { return null }
  }

  /** Fence the wake pending -> delivered. The server ignores stale wakeIds, and says
   *  so - which the channel server used to discard by never reading the response. */
  async function reportDelivered(wakeId) {
    if (!code || !wakeId) return
    try {
      const res = await fetch(`${base}/wake/delivered`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ part, holder, wakeId }),
        signal: AbortSignal.timeout(fetchTimeoutMs),
      })
      if (res.ok) {
        const d = await res.json().catch(() => ({}))
        if (d.stale) log(`delivered report stale (wake ${String(wakeId).slice(0, 8)} superseded) - ok`)
      }
    } catch { /* best-effort */ }
  }

  // Catch-up cooldown state lives per client instance, not per module, so two clients
  // in one process (tests, or a future multi-part host) cannot suppress each other.
  let lastCatchupWakeId = null
  let lastCatchupAt = 0

  /**
   * On every (re)connect, ask the server for a SINGLE coalesced wake decision for this
   * part. The server owns the "should this part be woken" question given wake state,
   * unread and budget; this never nudges per unread item. Calls `enqueue` at most once.
   */
  async function catchUp({ enqueue }) {
    if (!code) return
    try {
      const u = new URL(`${base}/pending-wake`)
      u.searchParams.set("part", part)
      u.searchParams.set("holder", holder)
      // Every reconnect runs catch-up; without a cap a hung request on a half-open
      // connection would accumulate and never resolve.
      const res = await fetch(u, { headers: authHeaders(), signal: AbortSignal.timeout(fetchTimeoutMs) })
      if (!res.ok) return
      const d = await res.json()
      if (!d.wake) {
        if (d.suppressed) log("catch-up: budget-suppressed, sweep will recover")
        return
      }
      const nowTs = Date.now()
      if (d.wakeId === lastCatchupWakeId && nowTs - lastCatchupAt < CATCHUP_COOLDOWN_MS) {
        return // same wake, re-delivered on a reconnect - the server settles it on ack
      }
      lastCatchupWakeId = d.wakeId
      lastCatchupAt = nowTs
      enqueue({ subject: d.subject, fromPart: d.fromPart, messageId: d.wakeId, count: d.count })
      log(`catch-up: 1 coalesced wake (${d.count ?? "?"} unread)`)
    } catch (err) {
      log("catch-up failed:", err.message)
    }
  }

  /**
   * Subscribe to the part's SSE stream until it ends or goes silent. Resolves when the
   * stream ends cleanly; REJECTS on a connect failure or on the idle watchdog firing,
   * which is how the consumer's reconnect loop learns to retry.
   *
   * `onConnect` runs once the stream is live (both consumers use it for catch-up:
   * the live stream only carries what arrives while connected).
   * `onMessage` receives real messages only - the same stream carries presence beats
   * (kind:'pager', one per heartbeat) which, treated as messages, would have each
   * heartbeat enqueue an empty wake and storm the agent.
   */
  async function subscribe({ onMessage, onConnect, idleMs = DEFAULT_SSE_IDLE_MS } = {}) {
    const headers = authHeaders({ accept: "text/event-stream" })
    const ctrl = new AbortController()
    const res = await fetch(sseUrl(), { headers, signal: ctrl.signal })
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status} ${res.statusText}`)
    log(`connected -> ${sseUrl()}`)
    onConnect?.()

    // Arm/re-arm on every byte: a half-open connection delivers nothing and never
    // ends, so without this the reader blocks forever and the part stops waking.
    let idle = setTimeout(() => ctrl.abort(), idleMs)
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), idleMs) }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let eventName = "message"
    let dataLines = [] // per the SSE spec an event may span several data: lines

    const dispatchEvent = () => {
      if (dataLines.length && eventName === "message") {
        try {
          const evt = JSON.parse(dataLines.join("\n"))
          if (evt.part === part && evt.kind === "message") {
            log(`event: "${evt.subject ?? ""}" from ${evt.fromPart ?? "?"}`)
            onMessage?.(evt)
          }
        } catch { /* non-JSON payload (ping) - ignore */ }
      }
      eventName = "message"
      dataLines = []
    }

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bump()
        buf += decoder.decode(value, { stream: true })

        let idx
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, "")
          buf = buf.slice(idx + 1)

          if (line === "") { dispatchEvent(); continue } // blank line ends the event
          if (line.startsWith(":")) continue // comment / keepalive
          if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue }
          // Strip ONE leading space after the colon (SSE spec); keep the rest verbatim.
          if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
        }
      }
    } finally {
      clearTimeout(idle) // stop the watchdog whether we ended cleanly or via abort
    }
  }

  return {
    authHeaders,
    sseUrl,
    claimLease,
    reportDelivered,
    catchUp,
    subscribe,
    // Bound to this client's holder so a consumer cannot pass the wrong one.
    leaseDecision: (lease) => leaseDecision(lease, holder),
    backoff,
  }
}
