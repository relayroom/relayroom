/**
 * Regression: postMessage / createThread must only accept recipients that are
 * actually addressable parts.
 *
 * `targetAgentIds` is client input and the project-scoped agent lookup is the
 * only server-side check on it, so it has to match what listAgentTargets offers.
 * postMessage previously filtered on project alone and createThread on project +
 * deletedAt, while listAgentTargets (what the composer shows) also excludes the
 * virtual 'human' participant - three different answers to one question. A
 * crafted request could therefore create recipient rows and fire a pager wake for
 * a soft-deleted part whose tokens deleteAgent had already revoked, or address
 * 'human', which is not an agent anyone can wake.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq, inArray } from "drizzle-orm"

let actingUserId = "recip-user"
const activeOrgId = "org-recip-scope"

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
import { projects, projectAccess, threads, messages, messageRecipients, agents } from "@relayroom/db/schema"
import {
  better_auth_user,
  better_auth_organization,
  better_auth_member,
} from "@relayroom/db/auth-schema"
import { postMessage, createThread } from "./actions"

const ORG = "org-recip-scope"
const USER = "recip-user"

let projectId: string
let threadId: string
let liveAgentId: string
let deletedAgentId: string
let humanAgentId: string

beforeEach(async () => {
  actingUserId = USER

  await db.delete(messageRecipients)
  await db.delete(messages)
  await db.delete(projectAccess)
  await db.delete(threads)
  await db.delete(agents)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))

  await db
    .insert(better_auth_organization)
    .values({ id: ORG, name: "Recipient Scope Org", createdAt: new Date() })
    .onConflictDoNothing()
  await db
    .insert(better_auth_user)
    .values({ id: USER, name: USER, email: `${USER}@test.local`, emailVerified: true })
    .onConflictDoNothing()
  await db
    .insert(better_auth_member)
    .values({ id: `m-${USER}`, organizationId: ORG, userId: USER, role: "member", createdAt: new Date() })
    .onConflictDoNothing()

  const [p] = await db
    .insert(projects)
    .values({
      organizationId: ORG,
      slug: "recip-scope",
      name: "Recipient Scope",
      connectCode: "recip-cc",
      createdByUserId: USER,
    })
    .returning({ id: projects.id })
  projectId = p!.id

  await db
    .insert(projectAccess)
    .values({ projectId, userId: USER, level: "write", createdByUserId: USER })

  const rows = await db
    .insert(agents)
    .values([
      { projectId, part: "live", role: "default", ownerUserId: USER },
      { projectId, part: "gone", role: "default", ownerUserId: USER, deletedAt: new Date() },
      { projectId, part: "human", role: "default" },
    ])
    .returning({ id: agents.id, part: agents.part })
  liveAgentId = rows.find((r) => r.part === "live")!.id
  deletedAgentId = rows.find((r) => r.part === "gone")!.id
  humanAgentId = rows.find((r) => r.part === "human")!.id

  const [th] = await db
    .insert(threads)
    .values({ projectId, subject: "recipient scope thread", createdByUserId: USER })
    .returning({ id: threads.id })
  threadId = th!.id
})

afterAll(async () => {
  await db.$client.end()
})

async function recipientAgentIds(messageId: string): Promise<string[]> {
  const rows = await db
    .select({ agentId: messageRecipients.agentId })
    .from(messageRecipients)
    .where(eq(messageRecipients.messageId, messageId))
  return rows.map((r) => r.agentId).sort()
}

describe("postMessage recipient scoping", () => {
  it("drops a soft-deleted agent and the 'human' part, keeping the live one", async () => {
    const res = await postMessage({
      threadId,
      body: "addressed to all three",
      targetAgentIds: [liveAgentId, deletedAgentId, humanAgentId],
    })
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(await recipientAgentIds(res.item.id)).toEqual([liveAgentId])
  })

  it("creates no recipient rows when every target is unaddressable", async () => {
    const res = await postMessage({
      threadId,
      body: "addressed to nobody real",
      targetAgentIds: [deletedAgentId, humanAgentId],
    })
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(await recipientAgentIds(res.item.id)).toEqual([])
  })

  it("does not accept an agent from another project", async () => {
    const [other] = await db
      .insert(projects)
      .values({
        organizationId: ORG,
        slug: "recip-scope-other",
        name: "Other",
        connectCode: "recip-cc-other",
        createdByUserId: USER,
      })
      .returning({ id: projects.id })
    const [foreign] = await db
      .insert(agents)
      .values({ projectId: other!.id, part: "foreign", role: "default", ownerUserId: USER })
      .returning({ id: agents.id })

    const res = await postMessage({
      threadId,
      body: "cross-project target",
      targetAgentIds: [foreign!.id],
    })
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(await recipientAgentIds(res.item.id)).toEqual([])
  })
})

describe("createThread recipient scoping", () => {
  it("drops the 'human' part, keeping the live one", async () => {
    const res = await createThread({
      projectId,
      subject: "new thread",
      body: "hello",
      targetAgentIds: [liveAgentId, humanAgentId],
    })
    expect(res.result).toBe(true)
    if (!res.result) return

    const msgs = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.threadId, res.item.id))
    expect(msgs).toHaveLength(1)
    expect(await recipientAgentIds(msgs[0]!.id)).toEqual([liveAgentId])
  })

  it("refuses to open a thread addressed only to unaddressable parts", async () => {
    const res = await createThread({
      projectId,
      subject: "doomed",
      body: "hello",
      targetAgentIds: [deletedAgentId, humanAgentId],
    })
    expect(res.result).toBe(false)
    // and no orphan thread was left behind
    const left = await db
      .select({ id: threads.id })
      .from(threads)
      .where(inArray(threads.subject, ["doomed"]))
    expect(left).toHaveLength(0)
  })
})
