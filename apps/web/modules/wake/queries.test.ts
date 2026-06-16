import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { projects, agents, wakeEvents } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"
import { getOwnerWakeBudget, listOwnerWakeAudit } from "./queries"

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
