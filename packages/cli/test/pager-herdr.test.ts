import { describe, expect, it } from "vitest"
// @ts-expect-error - runtime .mjs has no type declarations; tested at runtime only.
import { deliverViaHerdr, makeHerdrBackend, matchPaneByCwd, processesLookLikeAgent, screenContains, verificationNeedle } from "../runtime/pager-herdr.mjs"

/**
 * herdr delivery: stage -> verify -> submit -> confirm.
 *
 * THE PROPERTY THESE TESTS EXIST FOR is what happens when the verify FAILS. Measured on
 * herdr 0.8.0: `agent.prompt` sent input to an agent herdr itself reported as `blocked`,
 * and its trailing Enter answered Claude Code's "is this a project you trust?" dialog -
 * a wake choosing "trust" for the user. `pane.send_text` is inert against the same
 * dialog, so the algorithm stages first and submits only once it has SEEN the text in
 * the input box.
 *
 * A test that only covered the happy path would pass equally on a version that submits
 * blind, which is the version that answers dialogs. Every case below is therefore about
 * what is NOT sent.
 */

/** A scripted herdr server: each method returns whatever the script says, and every call
 *  is recorded so a test can assert on what was NOT sent. */
function fakeHerdr(script: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    const entry = script[method]
    if (entry === undefined) throw Object.assign(new Error(`unscripted ${method}`), { code: "invalid_request" })
    return typeof entry === "function" ? (entry as (p: Record<string, unknown>) => unknown)(params) : entry
  }
  return { call, calls, methods: () => calls.map((c) => c.method) }
}

const WAKE = "abcdef1234567890"
const TEXT = `📬 RelayRoom: new message "subject" from peer (you are part "p"). Use the inbox tool. (wake ${WAKE.slice(0, 8)})`

const RULE = "─".repeat(60)

/**
 * A pane as `pane.read` actually returns it.
 *
 * THE LAYOUT IS PART OF THE TEST, and an earlier version of this file is why: its fake
 * returned a bare string with no composer rules, so `composerText` found nothing and
 * every case silently exercised the FALLBACK path instead of the one that ships. A fake
 * that omits the structure under test is a fake that agrees with anything.
 *
 *   transcript...            <- submitted prompts stay visible here, forever
 *   ────────────
 *   ❯ <composer>             <- the only place text is still unsent
 *   ────────────
 *     status line
 */
const pane = ({ transcript = "", composer = "" }: { transcript?: string; composer?: string }) =>
  [transcript, RULE, composer ? `❯ ${composer.slice(0, 40)}\n  ${composer.slice(40)}` : "❯", RULE, "  ctx:80%"].join("\n")

/** The staged-but-unsent state: the wake is in the composer. */
const screenWith = (text: string) => pane({ composer: text })

/** The submitted state: the wake is echoed in the transcript and the composer is empty.
 *  This is the shape that made "is it on screen" useless as a confirm. */
const screenSubmitted = (text: string) => pane({ transcript: `❯ ${text}\n● a reply` })

describe("herdr delivery refuses to submit what it cannot see", () => {
  it("stages, verifies, and only then presses enter", async () => {
    let staged = false
    let submitted = false
    let seq = 10
    const h = fakeHerdr({
      "pane.read": () => ({
        read: { text: submitted ? screenSubmitted(TEXT) : staged ? screenWith(TEXT) : pane({}) },
      }),
      "pane.send_text": () => { staged = true; return {} },
      "pane.send_keys": () => { submitted = true; seq++; return {} },
      "agent.list": () => ({ agents: [{ pane_id: "w2:p4", state_change_seq: seq }] }),
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(true)
    // Order is the safety property, not an implementation detail: a read must sit
    // between the text and the enter, and the counter must be sampled BEFORE the enter
    // or "did it move" has nothing to compare against.
    expect(h.methods().slice(0, 6)).toEqual([
      "pane.read", "pane.send_text", "pane.read", "agent.list", "pane.send_keys", "pane.read",
    ])
  })

  it("confirms a MID-TURN submit, where the composer still shows the text", async () => {
    // The false negative a live run found: Claude Code keeps a submitted prompt visible
    // in its composer until the turn it queued behind starts, so "still on screen"
    // reported "not submitted" for a wake that had been submitted AND answered. Every
    // wake that lands mid-turn would have been delivered twice.
    let submitted = false
    let seq = 46
    const h = fakeHerdr({
      // The echo stays on screen for good - which is what made a whole-screen check
      // report "still here" about a wake that had already been answered.
      "pane.read": () => ({ read: { text: submitted ? screenSubmitted(TEXT) : screenWith(TEXT) } }),
      "pane.send_text": {},
      "pane.send_keys": () => { submitted = true; seq = 47; return {} },
      "agent.list": () => ({ agents: [{ pane_id: "w2:p4", state_change_seq: seq }] }),
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(true)
  })

  it("does NOT confirm when the counter moved but our text is still in the composer", async () => {
    // The false confirm, and the reason the counter cannot be the deciding signal: a turn
    // ENDING moves it too, with no input from us at all (measured: 61 -> 62 six seconds
    // after an unrelated submit). A swallowed Enter plus an in-flight turn finishing
    // inside the window would otherwise be reported as delivered - a wake marked done and
    // never seen by anyone.
    let seq = 61
    const h = fakeHerdr({
      "pane.read": { read: { text: screenWith(TEXT) } },  // composer never empties
      "pane.send_text": {},
      "pane.send_keys": {},                                // the Enter did nothing
      "agent.list": () => ({ agents: [{ pane_id: "w2:p4", state_change_seq: ++seq }] }),
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("still in the composer")
  })

  it("falls back to the counter when the composer cannot be located, and says so", async () => {
    // A layout this parser does not recognise - a future Claude Code, or another TUI.
    // Losing the strong signal must cost accuracy, not correctness, and it must be said.
    const notes: string[] = []
    let seq = 5
    const h = fakeHerdr({
      // No rules anywhere - an unrecognised layout. The staged text IS visible, so the
      // verify passes and the confirm is what this case is about.
      "pane.read": { read: { text: `some terminal with no rules at all\n$ ${TEXT}` } },
      "pane.send_text": {},
      "pane.send_keys": () => { seq = 6; return {} },
      "agent.list": () => ({ agents: [{ pane_id: "w2:p4", state_change_seq: seq }] }),
    })
    const res = await deliverViaHerdr({
      call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE, log: (m: string) => notes.push(m),
    })
    expect(res.ok).toBe(true)
    expect(notes.join(" ")).toContain("composer could not be located")
  })

  it("does not accept a counter that never moved", async () => {
    // The wrong-key-name case, now caught by the counter rather than by the screen: a key
    // herdr does not recognise leaves the text staged and the agent untouched.
    const h = fakeHerdr({
      "pane.read": { read: { text: screenWith(TEXT) } },
      "pane.send_text": {},
      "pane.send_keys": {},
      "agent.list": { agents: [{ pane_id: "w2:p4", state_change_seq: 46 }] },
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("still in the composer")
  })

  it("NEVER presses enter when the staged text is not on screen", async () => {
    // The dialog case. herdr accepted send_text (it always does), the dialog swallowed
    // it, and the input box is unchanged. An enter here would answer the dialog.
    const h = fakeHerdr({
      "pane.read": { read: { text: "Is this a project you trust?\n  1. Yes  2. No" } },
      "pane.send_text": {},
      "pane.send_keys": () => { throw new Error("enter must never be sent when the text was not seen") },
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("did not appear")
    expect(h.methods()).not.toContain("pane.send_keys")
  })

  it("does not re-stage text a dialog buffered, it submits it", async () => {
    // Measured behaviour: a dialog BUFFERS typed text and releases it into the input box
    // once a human answers. So the wake deferred a minute ago can already be sitting
    // there, and staging again would double it ("texttext").
    const h = fakeHerdr({
      "pane.read": { read: { text: screenWith(TEXT) } },
      "pane.send_text": () => { throw new Error("must not stage twice") },
      "pane.send_keys": {},
      "agent.list": { agents: [] },
    })
    // The confirm read still shows the text (this fake always does), so the result is a
    // refusal - but the point of the case is the absence of a second send_text.
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(h.methods()).not.toContain("pane.send_text")
    expect(res.ok).toBe(false)
  })

  it("reports failure when the text is still in the box after enter", async () => {
    // A wrong key name, or a TUI that folded the Enter into the composer. The response
    // to send_keys was a success either way - which is exactly why it is not the signal.
    const h = fakeHerdr({
      "pane.read": { read: { text: screenWith(TEXT) } },
      "pane.send_text": {},
      "pane.send_keys": {},
      // No agent here: herdr sees no agent in this pane, so the screen is the only
      // evidence there is - the fallback path.
      "agent.list": { agents: [] },
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("still in the composer")
  })

  it("treats a socket failure as a defer, not as a delivery", async () => {
    const h = fakeHerdr({
      "pane.read": { read: { text: "❯" } },
      "pane.send_text": () => { throw Object.assign(new Error("socket hung up"), { code: "socket" }) },
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(false)
    expect(h.methods()).not.toContain("pane.send_keys")
  })

  it("survives a read that fails only AFTER the submit", async () => {
    // The one place optimism is correct: the enter already landed, so re-queueing would
    // deliver the wake twice. Failing to observe is not evidence of failing to send.
    let reads = 0
    const h = fakeHerdr({
      "pane.read": () => {
        reads++
        if (reads <= 2) return { read: { text: screenWith(TEXT) } }
        throw Object.assign(new Error("gone"), { code: "socket" })
      },
      "pane.send_text": () => { throw new Error("already staged - should not re-stage") },
      "pane.send_keys": {},
      "agent.list": { agents: [] },
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(true)
  })
})

describe("what the verification matches on", () => {
  it("survives the input box wrapping the wake across lines", () => {
    expect(screenContains(screenWith(TEXT), verificationNeedle(TEXT, WAKE))).toBe(true)
  })

  it("does not match a DIFFERENT wake left on screen", () => {
    // Every wake starts with the same 60 characters, so a prefix match would accept the
    // previous wake still visible above the input box and submit into it.
    const older = TEXT.replace(WAKE.slice(0, 8), "99999999")
    expect(screenContains(screenWith(older), verificationNeedle(TEXT, WAKE))).toBe(false)
  })

  it("falls back to the tail when there is no wake id", () => {
    const needle = verificationNeedle(TEXT, null)
    expect(needle.length).toBeGreaterThan(8)
    expect(screenContains(screenWith(TEXT), needle)).toBe(true)
  })

  it("never matches on an empty needle", () => {
    // A needle that collapses to nothing would make every screen a match, including a
    // blank one - the verify would pass for a wake that was never staged.
    expect(screenContains("anything at all", "")).toBe(false)
    expect(screenContains("anything at all", "   \n  ")).toBe(false)
  })
})

describe("finding the pane, and whether an agent is in it", () => {
  const panes = [
    { pane_id: "w1:p1", cwd: "/home/u", foreground_cwd: "/home/u" },
    { pane_id: "w2:p4", cwd: "/repo/worktrees/server", foreground_cwd: "/repo/worktrees/server" },
    { pane_id: "w2:p5", cwd: "/repo", foreground_cwd: "/repo/worktrees/server" },
  ]

  it("joins on the worktree path", () => {
    expect(matchPaneByCwd(panes, "/repo/worktrees/server")?.pane_id).toBe("w2:p4")
    expect(matchPaneByCwd(panes, "/repo/worktrees/server/")?.pane_id).toBe("w2:p4")
  })

  it("prefers foreground_cwd, because that is where the keystrokes land", () => {
    expect(matchPaneByCwd([panes[2]], "/repo/worktrees/server")?.pane_id).toBe("w2:p5")
  })

  it("returns null rather than guessing when nothing matches", () => {
    expect(matchPaneByCwd(panes, "/somewhere/else")).toBeNull()
    expect(matchPaneByCwd(panes, "")).toBeNull()
  })

  it("tells an agent from a bare shell", () => {
    expect(processesLookLikeAgent([{ name: "zsh" }])).toBe(false)
    expect(processesLookLikeAgent([{ name: "-bash" }])).toBe(false)
    expect(processesLookLikeAgent([{ name: "zsh" }, { name: "claude" }])).toBe(true)
    // No processes at all is not an agent - and must not read as one.
    expect(processesLookLikeAgent([])).toBe(false)
    expect(processesLookLikeAgent(null)).toBe(false)
  })
})

describe("the backend the pager holds", () => {
  it("delivers through a pane it resolved by cwd", async () => {
    let staged = false
    const h = fakeHerdr({
      "pane.list": { panes: [{ pane_id: "w2:p4", cwd: "/wt", foreground_cwd: "/wt" }] },
      "pane.process_info": { process_info: { foreground_processes: [{ name: "claude" }] } },
      "pane.read": () => ({ read: { text: staged ? screenWith(TEXT) : pane({}) } }),
      "pane.send_text": () => { staged = true; return {} },
      "pane.send_keys": () => { staged = false; return {} },
      "agent.list": { agents: [] },
    })
    const backend = makeHerdrBackend({ call: h.call, worktreePath: "/wt" })
    expect(await backend.agentPresent()).toBe(true)
    expect(await backend.deliver(TEXT, WAKE)).toBe(true)
    expect(h.calls.filter((c) => c.method === "pane.send_keys")[0].params).toEqual({
      pane_id: "w2:p4",
      keys: ["enter"],
    })
  })

  it("does not deliver when no pane holds this worktree", async () => {
    const h = fakeHerdr({
      "pane.list": { panes: [{ pane_id: "w1:p1", cwd: "/elsewhere", foreground_cwd: "/elsewhere" }] },
      "pane.send_text": () => { throw new Error("must not type into a pane we did not identify") },
    })
    const backend = makeHerdrBackend({ call: h.call, worktreePath: "/wt" })
    expect(await backend.deliver(TEXT, WAKE)).toBe(false)
    expect(h.methods()).not.toContain("pane.send_text")
  })

  it("assumes the agent is present when it cannot tell, and drops the stale pane id", async () => {
    // Same rule as the tmux backend when `ps` is unavailable: uncertainty must not block
    // delivery forever, because the failure mode of blocking is silence.
    const h = fakeHerdr({ "pane.list": { panes: [] } })
    const backend = makeHerdrBackend({ call: h.call, worktreePath: "/wt" })
    expect(await backend.agentPresent()).toBe(true)
  })
})
