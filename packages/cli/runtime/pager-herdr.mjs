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
  let after
  try {
    after = await call("pane.read", { pane_id: paneId, source: "visible", lines: readLines })
  } catch (err) {
    return { ok: false, reason: `pane.read failed after staging (${err.code}): ${err.message}` }
  }
  if (!screenContains(after?.read?.text, needle)) {
    // Something swallowed it - a dialog, a dead pane, a TUI that is not accepting input.
    // NOTHING has been submitted and no dialog has been answered, which is the property
    // this ordering exists to guarantee. The wake stays queued.
    return { ok: false, reason: "staged text did not appear in the pane - deferring (nothing submitted)" }
  }

  try {
    await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] })
  } catch (err) {
    return { ok: false, reason: `pane.send_keys failed (${err.code}): ${err.message}` }
  }

  // CONFIRM. If the key name were wrong, or the TUI folded the Enter into the composer,
  // the text would still be sitting in the box - and reporting delivery then would be
  // the same lie the whole feature is built to stop telling.
  try {
    const done = await call("pane.read", { pane_id: paneId, source: "visible", lines: readLines })
    if (screenContains(done?.read?.text, needle)) {
      return { ok: false, reason: "text is still in the input box after enter - not submitted" }
    }
  } catch (err) {
    // The submit already happened; failing to READ afterwards is not evidence it did not
    // land, and re-queuing would deliver the wake twice. Report success and say why.
    log(`herdr: could not confirm after enter (${err.code}) - treating the submit as delivered`)
  }
  return { ok: true }
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
