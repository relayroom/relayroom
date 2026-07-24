/**
 * Thread-knowledge purge from the dashboard (FEAT-0004 L3).
 *
 * The purge logic itself is @relayroom/db's and tested there; these cover the web
 * action's contract: owner-only (checked from the action, not by which button
 * renders), dry-run counts without deleting, and the real purge honoring the
 * (다) semantic - sole-source entries deleted, multi-source entries detached. A
 * separate suite covers that closing a thread from the dashboard sets the
 * extractor marker.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"

let actingUserId = "pg-owner"

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>()
  return { ...actual, getServerSession: vi.fn(async () => ({ user: { id: actingUserId } })) }
})

import { db } from "@/lib/db"
import { projects, projectAccess, knowledge } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization, better_auth_member } from "@relayroom/db/auth-schema"
import { purgeThreadKnowledge } from "./purge-actions"

const ORG = "org-pg"
const OWNER = "pg-owner"
const WRITER = "pg-writer"
const THREAD_A = "00000000-0000-0000-0000-00000000000a"
const THREAD_B = "00000000-0000-0000-0000-00000000000b"

let projectId: string

async function seedMember(id: string, role: string) {
  await db.insert(better_auth_user).values({ id, name: id, email: `${id}@t.local`, emailVerified: true }).onConflictDoNothing()
  await db.insert(better_auth_member).values({ id: `m-${id}`, organizationId: ORG, userId: id, role, createdAt: new Date() }).onConflictDoNothing()
}

async function addEntry(refs: { threadId?: string }[], title = "k"): Promise<string> {
  const [r] = await db
    .insert(knowledge)
    .values({ projectId, kind: "fact", title, body: "b", sourceKind: "learn", sourceRefs: refs })
    .returning({ id: knowledge.id })
  return r!.id
}

async function exists(id: string): Promise<boolean> {
  const [r] = await db.select({ id: knowledge.id }).from(knowledge).where(eq(knowledge.id, id))
  return !!r
}

async function refsOf(id: string) {
  const [r] = await db.select({ refs: knowledge.sourceRefs }).from(knowledge).where(eq(knowledge.id, id))
  return r?.refs ?? []
}

beforeEach(async () => {
  actingUserId = OWNER
  await db.delete(knowledge)
  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.insert(better_auth_organization).values({ id: ORG, name: ORG, createdAt: new Date() }).onConflictDoNothing()
  await seedMember(OWNER, "member")
  await seedMember(WRITER, "member")

  const [p] = await db.insert(projects).values({ organizationId: ORG, slug: "pg", name: "PG", connectCode: "pg-cc", createdByUserId: OWNER }).returning({ id: projects.id })
  projectId = p!.id
  await db.insert(projectAccess).values([
    { projectId, userId: OWNER, level: "owner", createdByUserId: OWNER },
    { projectId, userId: WRITER, level: "write", createdByUserId: OWNER },
  ])
})

afterAll(async () => {
  await db.$client.end()
})

describe("purgeThreadKnowledge", () => {
  it("dry-run reports the split and deletes nothing", async () => {
    const sole = await addEntry([{ threadId: THREAD_A }], "sole")
    const multi = await addEntry([{ threadId: THREAD_A }, { threadId: THREAD_B }], "multi")

    const res = await purgeThreadKnowledge(projectId, THREAD_A, true)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item).toEqual({ deleted: 1, detached: 1 })

    // Nothing changed.
    expect(await exists(sole)).toBe(true)
    expect((await refsOf(multi))).toHaveLength(2)
  })

  it("real purge deletes sole-source and detaches multi-source (the 다 semantic)", async () => {
    const sole = await addEntry([{ threadId: THREAD_A }], "sole")
    const multi = await addEntry([{ threadId: THREAD_A }, { threadId: THREAD_B }], "multi")
    const untouched = await addEntry([{ threadId: THREAD_B }], "other-thread")

    const res = await purgeThreadKnowledge(projectId, THREAD_A, false)
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item).toEqual({ deleted: 1, detached: 1 })

    expect(await exists(sole)).toBe(false)            // sole source -> deleted
    expect(await exists(multi)).toBe(true)            // multi -> kept
    expect(await refsOf(multi)).toEqual([{ threadId: THREAD_B }]) // A stripped
    expect(await exists(untouched)).toBe(true)        // another thread -> untouched
    expect(await refsOf(untouched)).toEqual([{ threadId: THREAD_B }])
  })

  it("refuses a write grant (owner is the bar), and deletes nothing", async () => {
    const sole = await addEntry([{ threadId: THREAD_A }])
    actingUserId = WRITER
    const res = await purgeThreadKnowledge(projectId, THREAD_A, false)
    expect(res.result).toBe(false)
    expect(await exists(sole)).toBe(true)
  })

  it("a thread with no derived knowledge is a clean zero", async () => {
    const res = await purgeThreadKnowledge(projectId, THREAD_A, true)
    expect(res.result).toBe(true)
    if (res.result) expect(res.item).toEqual({ deleted: 0, detached: 0 })
  })
})
