/**
 * Closing a thread from the dashboard must set the extractor's dirty marker.
 *
 * Without it, a thread closed on the web would never carry knowledge_dirty_at and
 * the extractor would never distill it - the same shared setter the server's
 * closers call, so all three paths agree. The marker fires for closed/answered
 * (a resolution worth learning from) but not canceled.
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

describe("closeThread sets the extractor marker", () => {
  it("marks dirty when a thread is closed", async () => {
    await clearDirty()
    const threadId = await makeThread()
    const res = await closeThread({ threadId, status: "closed" })
    expect(res.result).toBe(true)
    expect(await dirtyAt()).not.toBeNull()
  })

  it("marks dirty when a thread is answered", async () => {
    await clearDirty()
    const threadId = await makeThread()
    const res = await closeThread({ threadId, status: "answered" })
    expect(res.result).toBe(true)
    expect(await dirtyAt()).not.toBeNull()
  })

  it("does NOT mark dirty on cancel - not a resolution to learn from", async () => {
    await clearDirty()
    const threadId = await makeThread()
    const res = await closeThread({ threadId, status: "canceled" })
    expect(res.result).toBe(true)
    expect(await dirtyAt()).toBeNull()
  })
})
