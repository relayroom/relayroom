/**
 * SEC-2 regression: a member banned from a project (project_access.bannedAt) must be
 * cut off on the WEB dashboard too, not just on the agent bus. Exercises the ban gate
 * added to the thread Server Actions against the real test DB. getServerSession /
 * resolveActiveOrgId are mocked to act as different principals; isBannedFromProject
 * stays REAL (spread of the actual module) so the gate is genuinely exercised.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

let actingUserId = "banned-user"
let activeOrgId: string | null = "org-ban-thread"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return {
    ...actual, // keep the REAL isBannedFromProject
    getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })),
  }
})
vi.mock("@/lib/active-org", () => ({
  resolveActiveOrgId: vi.fn(async () => activeOrgId),
}))

import { db } from "@/lib/db"
import { projects, projectAccess, threads } from "@relayroom/db/schema"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"
import { postMessage, createThread } from "./actions"

const ORG = "org-ban-thread"
const BANNED = "banned-user"
const OK = "ok-user"

let projectId: string
let threadId: string

async function seedUser(id: string) {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

beforeEach(async () => {
  actingUserId = BANNED
  activeOrgId = ORG

  await db.delete(projectAccess)
  await db.delete(threads)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))

  await db
    .insert(better_auth_organization)
    .values({ id: ORG, name: "Ban Thread Org", createdAt: new Date() })
    .onConflictDoNothing()
  for (const u of [BANNED, OK]) {
    await seedUser(u)
    await db
      .insert(better_auth_member)
      .values({ id: `m-${u}`, organizationId: ORG, userId: u, role: "member", createdAt: new Date() })
      .onConflictDoNothing()
  }

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: `ban-thread-${Date.now()}`,
      name: "Ban Thread Project",
      connectCode: `ban-thread-cc-${Date.now()}`,
      createdByUserId: OK,
    })
    .returning({ id: projects.id })
  projectId = p.id

  // BANNED has a banned project_access row; OK is a normal write member.
  await db.insert(projectAccess).values([
    { projectId, userId: BANNED, level: "readonly", bannedAt: new Date(), bannedByUserId: OK, createdByUserId: OK },
    { projectId, userId: OK, level: "write", createdByUserId: OK },
  ])

  const [th] = await db
    .insert(threads)
    .values({ projectId, subject: "ban test thread", createdByUserId: OK })
    .returning({ id: threads.id })
  threadId = th.id
})

afterAll(async () => {
  await db.$client.end()
})

describe("ban enforcement on thread Server Actions (SEC-2)", () => {
  it("blocks a banned member from posting a message", async () => {
    actingUserId = BANNED
    const res = await postMessage({ threadId, body: "let me back in", targetAgentIds: [] })
    expect(res.result).toBe(false)
  })

  it("blocks a banned member from opening a new thread", async () => {
    actingUserId = BANNED
    // A valid-uuid recipient so zod passes; the ban gate fires BEFORE recipient
    // resolution, so the agent need not exist.
    const res = await createThread({
      projectId,
      subject: "sneaky",
      body: "hi",
      targetAgentIds: ["00000000-0000-0000-0000-000000000000"],
    })
    expect(res.result).toBe(false)
  })

  it("does NOT block a non-banned member from posting", async () => {
    actingUserId = OK
    const res = await postMessage({ threadId, body: "all good", targetAgentIds: [] })
    expect(res.result).toBe(true)
  })
})
