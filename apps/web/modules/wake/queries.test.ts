import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { projects, agents, wakeEvents } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"
import { getOwnerWakeBudget, listOwnerWakeAudit, listProjectSuppressions } from "./queries"

const OWNER_A = "wake_owner_a"
const OWNER_B = "wake_owner_b"
const OWNER_C = "wake_owner_c" // no budget row, no events
const SENDER = "wake_sender"

let projectId: string
let agentId: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@wake.test`, emailVerified: true })
    .onConflictDoNothing()
}

beforeAll(async () => {
  for (const u of [OWNER_A, OWNER_B, OWNER_C, SENDER]) await seedUser(u)

  const [project] = await db
    .insert(projects)
    .values({
      organizationId: "test-org-wake",
      slug: "wake-test-proj",
      name: "Wake Test",
      connectCode: "wake-test-code",
    })
    .returning({ id: projects.id })
  projectId = project!.id

  const [agent] = await db
    .insert(agents)
    .values({ projectId, part: "backend", role: "main", ownerUserId: OWNER_A })
    .returning({ id: agents.id })
  agentId = agent!.id

  const now = Date.now()
  const hours = (h: number) => new Date(now - h * 60 * 60 * 1000)

  await db.insert(wakeEvents).values([
    // OWNER_A, recent: a normal charged wake.
    {
      ownerUserId: OWNER_A,
      agentId,
      projectId,
      senderPart: "frontend",
      senderUserId: SENDER,
      urgent: false,
      suppressed: false,
      createdAt: hours(1),
    },
    // OWNER_A, recent: an urgent wake.
    {
      ownerUserId: OWNER_A,
      agentId,
      projectId,
      senderPart: "frontend",
      senderUserId: SENDER,
      urgent: true,
      suppressed: false,
      createdAt: hours(2),
    },
    // OWNER_A, recent: a budget-exhausted SUPPRESSION (not a charged consume).
    {
      ownerUserId: OWNER_A,
      agentId,
      projectId,
      senderPart: "frontend",
      senderUserId: SENDER,
      urgent: false,
      suppressed: true,
      reason: "budget_exhausted",
      createdAt: hours(3),
    },
    // OWNER_A, OUTSIDE the 24h window (25h ago) - must be excluded.
    {
      ownerUserId: OWNER_A,
      agentId,
      projectId,
      senderPart: "frontend",
      senderUserId: SENDER,
      urgent: false,
      suppressed: false,
      createdAt: hours(25),
    },
    // OWNER_B, recent - must NEVER leak into OWNER_A's audit.
    {
      ownerUserId: OWNER_B,
      agentId,
      projectId,
      senderPart: "frontend",
      senderUserId: SENDER,
      urgent: true,
      suppressed: false,
      createdAt: hours(1),
    },
    // OWNER_A as the SENDER: a loop-breaker trip. This is the shape `pipeline.ts`
    // writes - ownerUserId is whoever tripped the breaker, and there is no agentId,
    // because the send never reached a part. It shares a column with the rows above
    // and means something else entirely.
    {
      ownerUserId: OWNER_A,
      projectId,
      senderPart: "backend",
      senderUserId: OWNER_A,
      urgent: false,
      suppressed: true,
      reason: "loop_breaker",
      createdAt: hours(1),
    },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("listOwnerWakeAudit", () => {
  it("returns only the owner's own rows within the window, with correct flags", async () => {
    const res = await listOwnerWakeAudit(OWNER_A, 24)
    expect(res.result).toBe(true)
    if (!res.result) return

    // 3 in-window rows for A (the 25h-old row is excluded); B's row never appears.
    expect(res.items).toHaveLength(3)
    expect(res.items.every((r) => r.senderUserId === SENDER)).toBe(true)

    // Joins resolved for display.
    expect(res.items[0]!.projectName).toBe("Wake Test")
    expect(res.items[0]!.agentPart).toBe("backend")
    expect(res.items[0]!.senderName).toBe(SENDER)

    // Flags map precisely.
    expect(res.items.filter((r) => r.urgent)).toHaveLength(1)
    expect(res.items.filter((r) => r.suppressed)).toHaveLength(1)

    // Summary matches the windowed set (25h-old row excluded).
    expect(res.summary.total).toBe(3)
    expect(res.summary.urgentCount).toBe(1)
    expect(res.summary.suppressedCount).toBe(1)
    expect(res.summary.windowHours).toBe(24)
  })

  it("isolates owners - B's events never appear in A's audit", async () => {
    const resB = await listOwnerWakeAudit(OWNER_B, 24)
    expect(resB.result).toBe(true)
    if (!resB.result) return
    expect(resB.items).toHaveLength(1)
    expect(resB.summary.total).toBe(1)
    expect(resB.summary.urgentCount).toBe(1)
  })
})

/**
 * `ownerUserId` carries two different subjects. A row with an agentId is a wake
 * aimed at a part this owner runs; a row without one is a send BY this user that
 * the loop breaker stopped. Before the split they were returned as one list, so a
 * blocked send appeared among the part's wakes with no part on it - an owner
 * reading it would count a suppression against a part that was never involved.
 */
describe("listOwnerWakeAudit splits the two axes", () => {
  it("keeps a loop-breaker trip out of the wakes-for-my-parts list", async () => {
    const res = await listOwnerWakeAudit(OWNER_A, 24)
    expect(res.result).toBe(true)
    if (!res.result) return

    // Still 3 - the loop-breaker row is A's and in-window, so before the split it
    // would have made this 4.
    expect(res.items).toHaveLength(3)
    expect(res.items.every((r) => r.agentId !== null)).toBe(true)
    expect(res.summary.total).toBe(3)
    expect(res.summary.suppressedCount).toBe(1) // the budget row, not the send
  })

  it("reports the blocked send on its own axis", async () => {
    const res = await listOwnerWakeAudit(OWNER_A, 24)
    expect(res.result).toBe(true)
    if (!res.result) return

    expect(res.blockedSends).toHaveLength(1)
    expect(res.blockedSends[0]!.agentId).toBeNull()
    expect(res.blockedSends[0]!.senderPart).toBe("backend")
    expect(res.blockedSendsSummary.total).toBe(1)
    expect(res.blockedSendsSummary.suppressedCount).toBe(1)
  })

  it("counts each axis from SQL, so neither summary includes the other's rows", async () => {
    const res = await listOwnerWakeAudit(OWNER_A, 24)
    expect(res.result).toBe(true)
    if (!res.result) return

    // The two totals partition the window; nothing is double-counted or dropped.
    expect(res.summary.total + res.blockedSendsSummary.total).toBe(4)
    expect(res.summary.suppressedCount + res.blockedSendsSummary.suppressedCount).toBe(2)
  })

  it("an owner with no blocked sends gets an empty axis, not the other axis' rows", async () => {
    const resB = await listOwnerWakeAudit(OWNER_B, 24)
    expect(resB.result).toBe(true)
    if (!resB.result) return
    expect(resB.blockedSends).toHaveLength(0)
    expect(resB.blockedSendsSummary.total).toBe(0)
  })
})

/**
 * The project-level view. The incident it exists for is "several parts are idle
 * and nothing says which one to look at", so it must answer starting from the
 * project rather than from a part the operator has already picked.
 */
describe("listProjectSuppressions", () => {
  it("groups withheld wakes by part and names the reason", async () => {
    const res = await listProjectSuppressions(projectId, OWNER_A, 24)
    expect(res.result).toBe(true)
    if (!res.result) return

    expect(res.items).toHaveLength(1)
    const part = res.items[0]!
    expect(part.part).toBe("backend")
    expect(part.total).toBe(1)
    // The reason is the whole point - "suppressed" without it is the screen this
    // replaces.
    expect(part.byReason).toEqual([{ reason: "budget_exhausted", count: 1 }])
  })

  it("excludes issued wakes - only what was WITHHELD belongs here", async () => {
    const res = await listProjectSuppressions(projectId, OWNER_A, 24)
    expect(res.result).toBe(true)
    if (!res.result) return
    // OWNER_A has two issued wakes on this part in the window. Counting them would
    // turn a busy part into an alarming one.
    expect(res.items[0]!.total).toBe(1)
  })

  it("excludes the blocked send, which has no part to group under", async () => {
    const res = await listProjectSuppressions(projectId, OWNER_A, 24)
    expect(res.result).toBe(true)
    if (!res.result) return
    // The loop-breaker row is suppressed, is OWNER_A's, and is in this project -
    // it is excluded only because it names no part. An inner join is doing that;
    // this pins it.
    expect(res.items.flatMap((p) => p.byReason).some((r) => r.reason === "loop_breaker")).toBe(false)
  })

  it("returns nothing for an owner whose parts were never withheld from", async () => {
    const res = await listProjectSuppressions(projectId, OWNER_B, 24)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.items).toHaveLength(0)
  })
})

describe("getOwnerWakeBudget", () => {
  it("returns spec defaults (30/5, isDefault) when no row exists", async () => {
    const res = await getOwnerWakeBudget(OWNER_C)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item.wakesPerHour).toBe(30)
    expect(res.item.urgentPerHour).toBe(5)
    expect(res.item.isDefault).toBe(true)
  })
})
