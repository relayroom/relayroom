import { readFileSync } from "node:fs"
import { describe, expect, it, vi, beforeEach } from "vitest"

/**
 * `up` typed inside the pane it is about used to detect ITSELF as the agent, skip the
 * launch, and then fail to name an agent that was never started - two contradictory lines
 * in one run, over a pane holding nothing but a shell. A user hit it doing the natural
 * thing: cd into the worktree in the pane herdr gave him, and run up.
 *
 * The fakes here carry the shape the real answer has - pids AND a foreground process
 * group - because the first fix was written against pids alone and passed everything
 * while the bug survived: rr.sh asks through `$CLI herdr status | sed`, so the group holds
 * a `sed` that is nobody's ancestor, and that `sed` still read as an agent.
 */
let panes: unknown[] = []
let procInfo: Record<string, unknown> = {}
const calls: Array<[string, unknown]> = []

vi.mock("../runtime/herdr-client.mjs", () => ({
  herdrCall: async (method: string, params: { pane_id?: string }) => {
    calls.push([method, params])
    if (method === "pane.list") return { panes }
    if (method === "pane.process_info") return { process_info: procInfo[params.pane_id ?? ""] ?? {} }
    return { type: "ok" }
  },
  handshake: async () => ({ ok: true, version: "0.8.0" }),
  herdrSocketPresent: () => true,
  herdrAgentName: (agent: string, part: string) => `${part}_${agent}`,
}))

const { agentRunning, findPane, paneHoldsCaller, selfProcessIdentity } = await import("../src/herdr")
const { processesLookLikeAgent } = await import("../runtime/pager-herdr.mjs")

/** This process's real group, read the same way the code reads it. The test asserts
 *  against the running process rather than a constant, so it cannot agree with a
 *  reader that is looking at the wrong field. */
const myGroup = Number(
  (() => {
    const stat = readFileSync("/proc/self/stat", "utf8")
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]
  })(),
)

describe("what counts as an agent", () => {
  it("ignores processes the caller owns, by pid", () => {
    // A node process in a herdr pane is reported as `MainThread` - measured - so no
    // name-based rule can tell the asker from an agent.
    expect(processesLookLikeAgent([{ name: "MainThread", pid: 42 }])).toBe(true)
    expect(processesLookLikeAgent([{ name: "MainThread", pid: 42 }], new Set([42]))).toBe(false)
    // An excluded pid must not excuse a real agent sitting beside it.
    expect(processesLookLikeAgent([{ name: "MainThread", pid: 42 }, { name: "claude", pid: 43 }], new Set([42]))).toBe(true)
  })

  it("knows its own pid and its own process group", () => {
    const me = selfProcessIdentity()
    expect(me.pids.has(process.pid)).toBe(true)
    expect(me.groups.has(myGroup)).toBe(true)
  })
})

describe("asking a pane about an agent without counting the asker", () => {
  beforeEach(() => { calls.length = 0; panes = []; procInfo = {} })

  it("a pane running the caller's own pipeline holds no agent", () => {
    // The exact shape rr.sh produces: `$CLI herdr status | sed`. `sed` is in the group and
    // is nobody's ancestor, so a pid-only exclusion still calls it an agent.
    procInfo["w1:p1"] = {
      foreground_process_group_id: myGroup,
      foreground_processes: [{ name: "MainThread", pid: process.pid }, { name: "sed", pid: 999999 }],
    }
    return expect(agentRunning("w1:p1")).resolves.toBe(false)
  })

  it("still sees a real agent in someone else's pane", async () => {
    // Negative control: the exclusion must not become a blanket "never an agent".
    procInfo["w1:p2"] = {
      foreground_process_group_id: myGroup + 1_000_000,
      foreground_processes: [{ name: "claude", pid: 555 }],
    }
    expect(await agentRunning("w1:p2")).toBe(true)
    expect(await paneHoldsCaller("w1:p2")).toBe(false)
  })

  it("excludes the caller by pid when the group does not match", async () => {
    // Both halves are load-bearing. A caller whose process group is not the pane's
    // foreground group - a job that was backgrounded and resumed, a wrapper that starts
    // its own session - is still in the process list, and it is still not an agent.
    procInfo["w1:p4"] = {
      foreground_process_group_id: myGroup + 7_000_000,
      foreground_processes: [{ name: "MainThread", pid: process.pid }],
    }
    expect(await agentRunning("w1:p4")).toBe(false)
    expect(await paneHoldsCaller("w1:p4")).toBe(true)
  })

  it("recognises its own pane through the group even when no pid matches", async () => {
    procInfo["w1:p3"] = { foreground_process_group_id: myGroup, foreground_processes: [{ name: "tee", pid: 888888 }] }
    expect(await paneHoldsCaller("w1:p3")).toBe(true)
  })
})

describe("finding the pane for a worktree", () => {
  beforeEach(() => { calls.length = 0; panes = []; procInfo = {} })

  it("prefers a real pane over the caller's own", async () => {
    // rr.sh cd's to the worktree root, so the CLI's cwd is the worktree and the pane the
    // user typed into reports that as its foreground_cwd - matching even when the real
    // target is elsewhere. Whichever came first in the list used to win.
    panes = [
      { pane_id: "w1:p1", workspace_id: "w1", cwd: "/home/u", foreground_cwd: "/work/tree" },
      { pane_id: "w2:p1", workspace_id: "w2", cwd: "/work/tree", foreground_cwd: "/work/tree" },
    ]
    procInfo["w1:p1"] = { foreground_process_group_id: myGroup, foreground_processes: [{ name: "MainThread", pid: process.pid }] }
    procInfo["w2:p1"] = { foreground_process_group_id: 4242, foreground_processes: [{ name: "claude", pid: 4242 }] }
    expect((await findPane("/work/tree"))?.pane_id).toBe("w2:p1")
  })

  it("returns the caller's own pane when that IS the worktree's pane", async () => {
    // The normal way to run this: sitting in the pane herdr gave you. The shell's cwd is
    // the worktree, so it is the right answer even though the caller is inside it.
    panes = [{ pane_id: "w3:p1", workspace_id: "w3", cwd: "/work/tree", foreground_cwd: "/work/tree" }]
    procInfo["w3:p1"] = { foreground_process_group_id: myGroup, foreground_processes: [{ name: "MainThread", pid: process.pid }] }
    expect((await findPane("/work/tree"))?.pane_id).toBe("w3:p1")
  })

  it("does not adopt the caller's pane when only the foreground cwd matches", async () => {
    // Run from ~ in another herdr pane: nothing here belongs to this worktree, and
    // inventing a pane would put the agent in someone else's window.
    panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/home/u", foreground_cwd: "/work/tree" }]
    procInfo["w1:p1"] = { foreground_process_group_id: myGroup, foreground_processes: [{ name: "MainThread", pid: process.pid }] }
    expect(await findPane("/work/tree")).toBeNull()
  })
})
