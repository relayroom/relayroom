/**
 * herdr delivery backend: stage -> verify -> submit -> confirm.
 *
 * WHY NOT `agent.prompt`, which is the method that exists for exactly this. Measured on
 * 2026-08-19 (stage-0 log, second pass, in a pane no human touched): with the agent
 * sitting on Claude Code's "Is this a project you trust?" dialog and herdr itself
 * reporting `agent_status: blocked`, `agent.prompt` did NOT return the documented
 * `agent_blocked` refusal. It sent the input, and **its trailing Enter answered the
 * security dialog** - the wake chose "trust" on the user's behalf, then ran its own text
 * as a prompt. A wake that can answer a permission dialog is worse than a wake that
 * arrives late.
 *
 * `pane.send_text` measured inert against the same dialog: the dialog stays up and the
 * text is buffered until a human answers it. That asymmetry is the whole algorithm -
 *
 *   1. send_text          stage the wake. Harmless if a dialog is up: nothing submits
 *   2. pane.read          is the staged text actually in the input box?
 *      no  -> something swallowed it. Defer. Nothing was submitted, nothing answered
 *   3. send_keys enter    only now, and only because step 2 saw it
 *   4. pane.read          gone from the input box => submitted. Still there => failed
 *
 * VERIFICATION IS THE SAFETY GATE, not a check bolted beside it. There is no dialog
 * detector here on purpose: herdr's own `agent_status` comes from screen-manifest
 * matching and reported the same dialog as `blocked` in one workspace and `idle` in
 * another minutes apart, so a text matcher of ours would be the same fragility one layer
 * down. We do not ask "is a dialog up"; we ask "did our text reach the input box", which
 * is the question whose answer we actually need.
 *
 * Step 4 exists because a success code is not delivery: `agent.prompt` returned success
 * on a just-started session and delivered nothing (log, finding 5). The same caution
 * applies to every write method here.
 */

/** herdr pane ids (`w2:p4`) are positional and move when workspaces are reordered or the
 *  server restarts; a worktree path does not. So the pane is resolved by cwd at delivery
 *  time and only cached within a delivery. */
export function matchPaneByCwd(panes, worktreePath) {
  if (!worktreePath) return null
  const want = worktreePath.replace(/\/+$/, "")
  // `foreground_cwd` first: it follows the process actually running (an agent that
  // cd'd), while `cwd` is where the shell started. When they disagree the foreground is
  // the one whose keystrokes we are aiming at.
  return (
    panes.find((p) => (p.foreground_cwd || "").replace(/\/+$/, "") === want) ||
    panes.find((p) => (p.cwd || "").replace(/\/+$/, "") === want) ||
    null
  )
}

/** Shells that mean "the agent exited and this is a bare prompt". Same set the tmux
 *  backend uses, for the same reason: typing a wake into a shell spams it. */
const SHELL_NAMES = new Set(["zsh", "bash", "sh", "fish", "tcsh", "dash", "ksh"])

/** Does this pane hold something other than a login shell? herdr answers directly with
 *  the foreground process list, which is the check tmux needed a `ps` subtree walk for. */
export function processesLookLikeAgent(processes) {
  if (!Array.isArray(processes) || processes.length === 0) return false
  return processes.some((p) => {
    const name = String(p?.name || "").replace(/^-/, "")
    return name && !SHELL_NAMES.has(name.split("/").pop())
  })
}

/**
 * Whitespace-insensitive containment.
 *
 * The input box WRAPS: a wake is one long line and `pane.read` returns it rendered, so
 * an exact substring test fails on exactly the wakes that arrived correctly. Comparing
 * with all whitespace removed survives wrapping, indentation and the box's borders,
 * while still being a real content match rather than a fuzzy one.
 */
export function screenContains(screenText, needle) {
  const flat = (s) => String(s || "").replace(/\s+/g, "")
  const n = flat(needle)
  return n.length > 0 && flat(screenText).includes(n)
}

/**
 * The part of the wake we verify on.
 *
 * Not the whole text: it is long, the box truncates, and a test that can only pass when
 * every character is visible would defer perfectly good deliveries. Not a fixed prefix
 * either - every wake starts identically, so a stale wake still on screen would satisfy
 * it. The wake tag is per-wake and lands at the END of the string, so seeing it means
 * the whole text got in.
 */
export function verificationNeedle(text, wakeId) {
  const tag = wakeId ? `(wake ${String(wakeId).slice(0, 8)})` : ""
  if (tag && text.includes(tag)) return tag
  // No wake id (the pager can nudge without one): fall back to the tail, which is still
  // per-message enough to distinguish this wake from the last one.
  return text.slice(-48)
}

/**
 * One delivery attempt. Returns { ok, reason } - `ok:false` is "defer, nothing was
 * submitted", never "assume it worked".
 *
 * `call` is injected so the algorithm can be exercised against a scripted server: the
 * one property worth testing here is what happens when the verify DOESN'T see the text,
 * and that is not reachable against a real pane on demand.
 */
/**
 * How long to give the terminal to RENDER what we just sent.
 *
 * Measured, and it is why these exist at all: the first live run of this algorithm sent
 * the text, read the pane in the same millisecond, saw an empty input box and deferred a
 * wake that arrived perfectly well a moment later. A single immediate read is a race with
 * the renderer, and the test fake did not have one because a fake answers instantly.
 *
 * This does not weaken the gate. A dialog never shows the text at all, so the dialog case
 * still deferrs - it just costs this window first. The window is spent only when
 * something is wrong.
 */
const RENDER_POLL_MS = 250
const RENDER_ATTEMPTS = 12   // ~3s

/** The confirm window is longer than the staging one: mid-turn, the composer can hold a
 *  submitted prompt until the queued turn actually starts. Bounded anyway - past this the
 *  wake is re-queued and delivered again rather than assumed. */
const CONFIRM_POLL_MS = 500
const CONFIRM_ATTEMPTS = 30  // ~15s

/** Read until the needle is present (want=true) or gone (want=false), or the window ends.
 *  Returns what was actually observed, never what was hoped for. */
async function readUntil({ call, paneId, needle, readLines, want }) {
  let last = ""
  for (let i = 0; i < RENDER_ATTEMPTS; i++) {
    const res = await call("pane.read", { pane_id: paneId, source: "visible", lines: readLines })
    last = res?.read?.text ?? ""
    if (screenContains(last, needle) === want) return { matched: true, text: last }
    await new Promise((r) => setTimeout(r, RENDER_POLL_MS))
  }
  return { matched: false, text: last }
}

/**
 * The COMPOSER's contents - the text sitting in the input box, not the whole screen.
 *
 * WHY THIS EXISTS, and it is the same mistake twice: a submitted prompt stays visible in
 * the transcript ABOVE the input box, so "is our text on screen" answers yes both when it
 * is waiting to be sent and when it has already been sent and answered. Measured - the
 * needle read as present for 26 seconds after a submit that had completed and been
 * replied to, because the echo was what matched.
 *
 * Claude Code draws the composer between two full-width rules at the bottom of the pane:
 *
 *     ❯ 📬 RelayRoom: ... (wake dd66e000)      <- transcript echo, already submitted
 *     ● ...the reply...
 *     ──────────────────────────────────────
 *     ❯ Write the numbers 1 to 1000 ...        <- THE COMPOSER
 *     ──────────────────────────────────────
 *       /tmp/... status line
 *
 * Structural, not textual: it looks for the last two rules, never for words. If the
 * layout ever changes this returns null and the caller falls back to the weaker signal
 * rather than guessing - a UI change should cost accuracy, not correctness.
 */
export function composerText(screenText) {
  const lines = String(screenText || "").split("\n")
  const rules = []
  lines.forEach((l, i) => { if (/^\s*─{20,}\s*$/.test(l)) rules.push(i) })
  if (rules.length < 2) return null
  const top = rules[rules.length - 2]
  const bottom = rules[rules.length - 1]
  if (bottom - top < 1) return null
  return lines.slice(top + 1, bottom).join("\n")
}

/**
 * herdr's monotone counter of agent state transitions for this pane, or null when herdr
 * sees no agent here.
 *
 * THE CONFIRM SIGNAL, and the reason it is not the screen. Measured mid-turn: after the
 * Enter, Claude Code keeps the submitted text VISIBLE in its composer until the turn it
 * queued behind actually starts - so "the text is still on screen" reported "not
 * submitted" for a wake that had been submitted and answered. That false negative costs
 * a duplicate wake every time a wake lands mid-turn, which is most of them.
 *
 * `state_change_seq` moved 46 -> 47 within one second of the Enter, and did NOT move when
 * the text was merely staged. It is evidence about the submit rather than about the
 * rendering, which is what step 4 of the stage-0 algorithm meant by "confirm by state
 * transition or echo" - this is the transition half, and it is the half that survives a
 * busy agent.
 *
 * Deliberately the SEQ and not `agent_status`: the same run reported `done` while the
 * agent was visibly mid-turn. A counter of observed transitions is a fact; a judgement
 * about which state the agent is in is the screen-manifest guess this design avoids
 * everywhere else.
 *
 * BUT IT IS A NECESSARY SIGNAL, NOT A SUFFICIENT ONE, and that was measured too: a turn
 * ENDING moves it as well, with no input from us at all (61 -> 62 six seconds after a
 * submit, while nothing was being sent). So a swallowed Enter plus an in-flight turn that
 * happens to finish inside the confirm window would look exactly like a successful
 * submit. That is why the composer decides whenever it can be found; this counter only
 * rules out "nothing happened at all".
 *
 * NOT MEASURED: the full set of transitions that move it. Turn start and turn end are
 * confirmed; anything else - a tool boundary, a subagent, a status refresh - is unknown.
 * Nothing here may treat this counter as proof that OUR text was submitted.
 */
async function agentSeq(call, paneId) {
  try {
    const list = await call("agent.list", {})
    const mine = (list?.agents ?? []).find((a) => a.pane_id === paneId)
    return typeof mine?.state_change_seq === "number" ? mine.state_change_seq : null
  } catch {
    return null
  }
}

export async function deliverViaHerdr({ call, paneId, text, wakeId, readLines = 12, log = () => {} }) {
  const needle = verificationNeedle(text, wakeId)

  // PRE-CHECK, and the one thing it is for: a dialog BUFFERS staged text and releases it
  // into the input box after a human answers. So a wake deferred at step 2 can still be
  // sitting there when the next attempt runs, and staging again would double it. If our
  // needle is already on screen, skip straight to submitting it.
  let staged = false
  try {
    const before = await call("pane.read", { pane_id: paneId, source: "visible", lines: readLines })
    if (screenContains(before?.read?.text, needle)) {
      staged = true
      log("herdr: wake already staged (buffered by a dialog?) - submitting rather than re-staging")
    }
  } catch (err) {
    return { ok: false, reason: `pane.read failed before staging (${err.code}): ${err.message}` }
  }

  if (!staged) {
    try {
      await call("pane.send_text", { pane_id: paneId, text })
    } catch (err) {
      return { ok: false, reason: `pane.send_text failed (${err.code}): ${err.message}` }
    }
  }

  // VERIFY. The response to send_text says nothing about where the text went.
  let seen
  try {
    seen = await readUntil({ call, paneId, needle, readLines, want: true })
  } catch (err) {
    return { ok: false, reason: `pane.read failed after staging (${err.code}): ${err.message}` }
  }
  if (!seen.matched) {
    // Something swallowed it - a dialog, a dead pane, a TUI that is not accepting input.
    // NOTHING has been submitted and no dialog has been answered, which is the property
    // this ordering exists to guarantee. The wake stays queued.
    return { ok: false, reason: "staged text did not appear in the pane - deferring (nothing submitted)" }
  }

  // Read the transition counter BEFORE the Enter, so "did it move" is answerable.
  const seqBefore = await agentSeq(call, paneId)

  try {
    // `enter`, and key names are `+`-joined when they are chords: `ctrl+u` is accepted,
    // `ctrl-u` answers `invalid_key`. Measured, and it fails loudly either way.
    await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] })
  } catch (err) {
    return { ok: false, reason: `pane.send_keys failed (${err.code}): ${err.message}` }
  }

  // CONFIRM. If the key name were wrong, or the TUI folded the Enter into the composer,
  // the text would still be sitting in the box - and reporting delivery then would be
  // the same lie the whole feature is built to stop telling.
  // CONFIRM. Two signals, answering different questions:
  //
  //   the COMPOSER emptying   - about OUR text specifically. The strong one
  //   the transition counter  - about the agent in general. Rules out "nothing happened"
  //
  // The composer decides whenever it can be located, because the counter also moves when
  // an unrelated turn ends - a swallowed Enter during a turn that finishes inside this
  // window would otherwise read as a successful submit, and that is a wake reported
  // delivered and never seen by anyone.
  //
  // The bias is deliberate: an unconfirmed delivery is re-queued, costing a duplicate
  // wake. A wrongly confirmed one is silence. Between those two this errs toward the
  // duplicate every time.
  let sawComposer = false
  let seqMoved = false
  for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
    let screen
    try {
      const res = await call("pane.read", { pane_id: paneId, source: "visible", lines: readLines })
      screen = res?.read?.text ?? ""
    } catch (err) {
      // The submit already happened; failing to READ afterwards is not evidence it did
      // not land, and re-queuing would deliver the wake twice.
      log(`herdr: could not read while confirming (${err.code}) - treating the submit as delivered`)
      return { ok: true }
    }
    const composer = composerText(screen)
    if (composer !== null) {
      sawComposer = true
      if (!screenContains(composer, needle)) return { ok: true }
    }
    if (seqBefore !== null) {
      const now = await agentSeq(call, paneId)
      if (now !== null && now > seqBefore) {
        seqMoved = true
        // Decisive ONLY when the composer cannot be found. Otherwise keep waiting for the
        // box to empty, which is the signal that is about our own text.
        if (!sawComposer) {
          log("herdr: confirmed by state change only - the composer could not be located")
          return { ok: true }
        }
      }
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS))
  }
  return {
    ok: false,
    reason: sawComposer
      ? `the wake is still in the composer after ${(CONFIRM_ATTEMPTS * CONFIRM_POLL_MS) / 1000}s - not submitted`
      : seqMoved
        ? "the agent changed state but nothing could be confirmed about our text"
        : "no agent state change and no readable composer - not submitted",
  }
}

/**
 * The backend the pager holds. Same three questions the tmux backend answers, so the
 * flush loop does not know which multiplexer it is on.
 */
export function makeHerdrBackend({ call, worktreePath, log = () => {} }) {
  let cachedPaneId = null

  async function resolvePane() {
    if (cachedPaneId) return cachedPaneId
    const list = await call("pane.list", {})
    const pane = matchPaneByCwd(list?.panes ?? [], worktreePath)
    if (!pane) throw new Error(`no herdr pane has cwd ${worktreePath}`)
    cachedPaneId = pane.pane_id
    return cachedPaneId
  }

  return {
    describe: () => `herdr(${worktreePath})`,
    async agentPresent() {
      try {
        const paneId = await resolvePane()
        const info = await call("pane.process_info", { pane_id: paneId })
        return processesLookLikeAgent(info?.process_info?.foreground_processes)
      } catch (err) {
        // A pane id can go stale (workspace closed and reopened). Drop the cache so the
        // next attempt re-resolves by cwd, and do NOT block delivery on uncertainty -
        // the same rule the tmux backend follows when `ps` is unavailable.
        cachedPaneId = null
        log(`herdr: agentPresent could not answer (${err.message}) - assuming present`)
        return true
      }
    },
    // No defer loop. The tmux backend waits for the pane to LOOK quiet because typing is
    // irreversible there; here staging is reversible by construction - if the moment is
    // wrong the text does not appear and nothing is submitted. Waiting for quiet would
    // add latency to buy a guarantee the verify already provides.
    async waitUntilQuiet() {},
    async deliver(text, wakeId) {
      let paneId
      try { paneId = await resolvePane() }
      catch (err) { cachedPaneId = null; log(`herdr: ${err.message}`); return false }
      const res = await deliverViaHerdr({ call, paneId, text, wakeId, log })
      if (!res.ok) {
        cachedPaneId = null // re-resolve next time; the pane may have moved
        log(`herdr: ${res.reason}`)
      }
      return res.ok
    },
  }
}
