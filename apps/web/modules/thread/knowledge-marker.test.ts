/**
 * Closing a thread from the dashboard records that the project's conversations
 * moved, through the same shared setter the server's closers call.
 *
 * NOTHING READS `knowledge_dirty_at` TODAY. The automatic extractor was its only
 * reader and was removed in 0.7.0; the column is kept because a cross-thread
 * reflection pass needs exactly the question it answers. These cases pin which
 * statuses write it, so the three closers keep agreeing until that reader arrives -
 * they are not evidence that anything acts on it.
 *
 * Which statuses: closed only. Not answered, which means "I have replied", and not
 * canceled. The previous version of this comment said closed AND answered while the
 * case below asserted the opposite, which is the reason a header is worth checking
 * against the assertions under it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

let actingUserId = "km-user"
let activeOrgId: string | null = "org-km"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return { ...actual, getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })) }
})
vi.mock("@/lib/active-org", () => ({ resolveActiveOrgId: vi.fn(async () => activeOrgId) }))

import { db } from "@/lib/db"
import { projects, projectAccess, threads } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization, better_auth_member } from "@relayroom/db/auth-schema"
import { closeThread } from "./actions"
import { setThreadStatusIfUnchanged } from "./status-write"

const ORG = "org-km"
const USER = "km-user"

let projectId: string

async function makeThread(): Promise<string> {
  const [th] = await db
    .insert(threads)
    .values({ projectId, subject: "km thread", status: "open", createdByUserId: USER })
    .returning({ id: threads.id })
  return th!.id
}

async function dirtyAt(): Promise<Date | null> {
  const [p] = await db.select({ d: projects.knowledgeDirtyAt }).from(projects).where(eq(projects.id, projectId))
  return p?.d ?? null
}

async function clearDirty() {
  await db.update(projects).set({ knowledgeDirtyAt: null }).where(eq(projects.id, projectId))
}

beforeEach(async () => {
  actingUserId = USER
  activeOrgId = ORG
  await db.delete(threads)
  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.insert(better_auth_organization).values({ id: ORG, name: ORG, createdAt: new Date() }).onConflictDoNothing()
  await db.insert(better_auth_user).values({ id: USER, name: USER, email: `${USER}@t.local`, emailVerified: true }).onConflictDoNothing()
  await db.insert(better_auth_member).values({ id: `m-${USER}`, organizationId: ORG, userId: USER, role: "member", createdAt: new Date() }).onConflictDoNothing()

  const [p] = await db.insert(projects).values({ organizationId: ORG, slug: "km", name: "KM", connectCode: "km-cc", createdByUserId: USER }).returning({ id: projects.id })
  projectId = p!.id
  await db.insert(projectAccess).values({ projectId, userId: USER, level: "write", createdByUserId: USER })
})

afterAll(async () => {
  await db.$client.end()
})

describe("closeThread and the knowledge marker", () => {
  it("marks dirty when a thread is closed", async () => {
    await clearDirty()
    const threadId = await makeThread()
    const res = await closeThread({ threadId, status: "closed" })
    expect(res.result).toBe(true)
    expect(await dirtyAt()).not.toBeNull()
  })

  it("does NOT mark dirty when a thread is answered - answered means replied, not finished", async () => {
    // This used to assert the opposite. Answered is a live state: autoclose treats
    // it as such and closes it once idle. Recording the project as having moved on
    // a thread that has not finished would put a timestamp on a conversation still
    // in progress, and the marker's whole value to its eventual reader is that it
    // marks conversations that are done.
    await clearDirty()
    const threadId = await makeThread()
    const res = await closeThread({ threadId, status: "answered" })
    expect(res.result).toBe(true)
    expect(await dirtyAt()).toBeNull()
  })

  it("does NOT mark dirty on cancel - not a resolution to learn from", async () => {
    await clearDirty()
    const threadId = await makeThread()
    const res = await closeThread({ threadId, status: "canceled" })
    expect(res.result).toBe(true)
    expect(await dirtyAt()).toBeNull()
  })
})

/**
 * The dashboard's status write races every other closer - the MCP `close` tool and
 * autoclose write the same column.
 *
 * Before this was conditional the later writer simply won: an agent could close a
 * thread - writing its lesson and marking the project - and a dashboard action a
 * moment later would move the status back, with BOTH callers told they succeeded,
 * leaving a lesson recorded against a thread that is not closed.
 *
 * These test the compare-and-set directly rather than through `closeThread`. The
 * interleaving cannot be reproduced from a test that calls the action - anything
 * written beforehand is simply what the action then reads, so the condition would
 * match and the test would pass while proving nothing. Driving the mechanism with a
 * stale expectation is the same comparison the race performs.
 */
describe("setThreadStatusIfUnchanged", () => {
  it("refuses when the row no longer holds the status the caller saw", async () => {
    const threadId = await makeThread() // 'open'
    // Stand in for the MCP close that landed after the action read 'open'.
    await db.update(threads).set({ status: "closed" }).where(eq(threads.id, threadId))

    const changed = await setThreadStatusIfUnchanged({
      threadId,
      orgId: ORG,
      expected: "open",
      next: "open",
    })

    expect(changed).toBe(false)
    // The assertion that matters is not the return value - it is that the other
    // writer's close is still there. A test checking only the boolean would pass
    // against an implementation that reported false and overwrote anyway.
    const [row] = await db.select({ status: threads.status }).from(threads).where(eq(threads.id, threadId))
    expect(row!.status).toBe("closed")
  })

  it("applies the change when the expectation still holds", async () => {
    // Negative control. Without it a condition that refused everything would look
    // correct on the test above, and the dashboard would silently stop working.
    const threadId = await makeThread()

    const changed = await setThreadStatusIfUnchanged({
      threadId,
      orgId: ORG,
      expected: "open",
      next: "closed",
    })

    expect(changed).toBe(true)
    const [row] = await db.select({ status: threads.status }).from(threads).where(eq(threads.id, threadId))
    expect(row!.status).toBe("closed")
  })

  it("refuses a thread in another org even when the status matches", async () => {
    // The org check and the status check are both in one predicate; this pins that
    // adding the status condition did not displace the IDOR guard.
    const threadId = await makeThread()

    const changed = await setThreadStatusIfUnchanged({
      threadId,
      orgId: "some-other-org",
      expected: "open",
      next: "closed",
    })

    expect(changed).toBe(false)
    const [row] = await db.select({ status: threads.status }).from(threads).where(eq(threads.id, threadId))
    expect(row!.status).toBe("open")
  })
})
