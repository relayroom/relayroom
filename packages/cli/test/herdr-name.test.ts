import { describe, expect, it, vi, beforeEach } from "vitest"

/**
 * `agent.rename` is what makes one part's row in herdr's agent sidebar different from
 * another's. Everything else an agent row could be identified by is shared by
 * construction: the fleet lives in ONE grouped workspace (label "relayroom"), every
 * worktree belongs to the same repo, and the terminal title is Claude Code's - it writes
 * "Claude Code" and then whatever the conversation turned out to be about.
 *
 * The parameter shape is measured, not guessed, and it is not the one its neighbours
 * take: `{ target, name }`, where `pane_id` answers `missing field 'target'`. The test
 * pins that because the failure is quiet - `up` treats naming as cosmetic, so a
 * regression to `pane_id` would leave every part sharing a label with nothing failing.
 */
const calls: Array<[string, unknown]> = []
let paneAnswer: unknown = { panes: [{ pane_id: "w2:p4", workspace_id: "w2", cwd: "/w" }] }
let renameThrows: Error | null = null

vi.mock("../runtime/herdr-client.mjs", () => ({
  herdrCall: async (method: string, params: unknown) => {
    calls.push([method, params])
    if (method === "pane.list") return paneAnswer
    if (method === "agent.rename") { if (renameThrows) throw renameThrows; return { type: "agent_info" } }
    return { type: "ok" }
  },
  handshake: async () => ({ ok: true, version: "0.8.0" }),
  herdrSocketPresent: () => true,
}))

const { nameAgent } = await import("../src/herdr")

describe("naming a part's agent row", () => {
  beforeEach(() => {
    calls.length = 0
    paneAnswer = { panes: [{ pane_id: "w2:p4", workspace_id: "w2", cwd: "/w" }] }
    renameThrows = null
  })

  it("renames the pane resolved by cwd, with the parameter herdr actually wants", async () => {
    expect(await nameAgent("/w", "rrc-server-gb10")).toEqual({ named: true, pane: "w2:p4" })
    const rename = calls.find(([m]) => m === "agent.rename")
    expect(rename?.[1]).toEqual({ target: "w2:p4", name: "rrc-server-gb10" })
  })

  it("reports rather than throws when there is no pane for this worktree", async () => {
    paneAnswer = { panes: [] }
    const res = await nameAgent("/w", "part")
    expect(res.named).toBe(false)
    expect(res.why).toMatch(/no herdr pane/)
    // Nothing was renamed - naming a pane we could not find would be naming someone
    // else's.
    expect(calls.some(([m]) => m === "agent.rename")).toBe(false)
  })

  it("a refused rename does not become an exception in the launch path", async () => {
    renameThrows = Object.assign(new Error("agent not found"), { code: "agent_not_found" })
    const res = await nameAgent("/w", "part")
    expect(res).toEqual({ named: false, pane: "w2:p4", why: "agent not found" })
  })
})
