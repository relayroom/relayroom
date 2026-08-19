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

/** A pane whose input box shows the staged text, the way `pane.read` returns it - wrapped
 *  across lines, which is why the matcher ignores whitespace. */
const screenWith = (text: string) =>
  `❯ ${text.slice(0, 40)}\n  ${text.slice(40, 90)}\n  ${text.slice(90)}\n───────────\n  ctx:80%`

describe("herdr delivery refuses to submit what it cannot see", () => {
  it("stages, verifies, and only then presses enter", async () => {
    let staged = false
    const h = fakeHerdr({
      "pane.read": () => ({ read: { text: staged ? screenWith(TEXT) : "❯\n───────────" } }),
      "pane.send_text": () => { staged = true; return {} },
      "pane.send_keys": () => { staged = false; return {} }, // submitted: the box empties
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(true)
    // Order is the safety property, not an implementation detail: a read must sit
    // between the text and the enter.
    expect(h.methods()).toEqual(["pane.read", "pane.send_text", "pane.read", "pane.send_keys", "pane.read"])
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
    })
    const res = await deliverViaHerdr({ call: h.call, paneId: "w2:p4", text: TEXT, wakeId: WAKE })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("still in the input box")
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
      "pane.read": () => ({ read: { text: staged ? screenWith(TEXT) : "❯" } }),
      "pane.send_text": () => { staged = true; return {} },
      "pane.send_keys": () => { staged = false; return {} },
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
