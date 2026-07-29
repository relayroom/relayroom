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

import { and, eq as eqCol } from "drizzle-orm"
import { db } from "@/lib/db"
import { projects, projectAccess, knowledge, threads, threadExtractions } from "@relayroom/db/schema"
import { better_auth_user, better_auth_organization, better_auth_member } from "@relayroom/db/auth-schema"
import { purgeThreadKnowledge, searchPurgeableThreads } from "./purge-actions"

const ORG = "org-pg"
const OWNER = "pg-owner"
const WRITER = "pg-writer"
const THREAD_A = "00000000-0000-0000-0000-00000000000a"
const THREAD_B = "00000000-0000-0000-0000-00000000000b"
/** Seeded in a SECOND project, to aim the action across the boundary on purpose. */
const THREAD_FOREIGN = "00000000-0000-0000-0000-00000000000f"

let projectId: string
let otherProjectId: string

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

/** Did purge leave the "do not extract this again" record for a thread? */
async function watermarkReason(pid: string, threadId: string): Promise<string | null> {
  const [r] = await db
    .select({ reason: threadExtractions.reason })
    .from(threadExtractions)
    .where(and(eqCol(threadExtractions.projectId, pid), eqCol(threadExtractions.threadId, threadId)))
  return r?.reason ?? null
}

beforeEach(async () => {
  actingUserId = OWNER
  await db.delete(knowledge)
  await db.delete(threadExtractions)
  await db.delete(threads)
  await db.delete(projectAccess)
  await db.delete(projects).where(eq(projects.organizationId, ORG))
  await db.delete(better_auth_member).where(eq(better_auth_member.organizationId, ORG))
  await db.insert(better_auth_organization).values({ id: ORG, name: ORG, createdAt: new Date() }).onConflictDoNothing()
  await seedMember(OWNER, "member")
  await seedMember(WRITER, "member")

  const [p] = await db.insert(projects).values({ organizationId: ORG, slug: "pg", name: "PG", connectCode: "pg-cc", createdByUserId: OWNER }).returning({ id: projects.id })
  projectId = p!.id
  const [other] = await db.insert(projects).values({ organizationId: ORG, slug: "pg2", name: "PG2", connectCode: "pg2-cc", createdByUserId: OWNER }).returning({ id: projects.id })
  otherProjectId = other!.id
  await db.insert(projectAccess).values([
    { projectId, userId: OWNER, level: "owner", createdByUserId: OWNER },
    { projectId, userId: WRITER, level: "write", createdByUserId: OWNER },
  ])

  // The threads must exist as rows. purgeKnowledgeFromThread now checks that the
  // thread belongs to the project before writing anything, so a bare uuid that
  // names no thread is rejected rather than quietly treated as "nothing to purge".
  await db.insert(threads).values([
    { id: THREAD_A, projectId, subject: "leaked secret discussion" },
    { id: THREAD_B, projectId, subject: "unrelated planning" },
    { id: THREAD_FOREIGN, projectId: otherProjectId, subject: "another project's thread" },
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

/**
 * The remedy in the 0.5.2 release note: an operator whose purged knowledge came
 * back re-runs the purge after upgrading. Everything below is that sentence.
 *
 * The thread they must reach has ZERO citing entries - the earlier purge removed
 * them - so every assertion here uses a thread with no knowledge. That is the case
 * the old flow could neither offer in the picker nor execute once chosen, and a
 * "purge deletes rows" test passes happily while it is broken.
 */
describe("purging a thread that no knowledge cites (the BUG-0010 remedy)", () => {
  it("records the purged watermark through the owner surface, with nothing to delete", async () => {
    expect(await watermarkReason(projectId, THREAD_A)).toBeNull()

    const res = await purgeThreadKnowledge(projectId, THREAD_A, false)

    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.item).toEqual({ deleted: 0, detached: 0 })
    // The counts are zero and the operation still did the thing it was for.
    expect(await watermarkReason(projectId, THREAD_A)).toBe("purged")
  })

  it("overwrites an earlier 'extracted' claim, so a distilled thread can still be suppressed", async () => {
    await db.insert(threadExtractions).values({ projectId, threadId: THREAD_A, reason: "extracted" })

    const res = await purgeThreadKnowledge(projectId, THREAD_A, false)
    expect(res.result).toBe(true)
    expect(await watermarkReason(projectId, THREAD_A)).toBe("purged")
  })

  it("NEGATIVE CONTROL: the dry run the confirm dialog depends on writes no watermark", async () => {
    // The UI always dry-runs to fill in the confirmation. If that left a
    // watermark, an owner who then clicked Cancel would have silently suppressed
    // the thread anyway - a destructive preview.
    const res = await purgeThreadKnowledge(projectId, THREAD_A, true)
    expect(res.result).toBe(true)
    expect(await watermarkReason(projectId, THREAD_A)).toBeNull()
  })

  it("refuses a write grant here too, and leaves no watermark", async () => {
    actingUserId = WRITER
    const res = await purgeThreadKnowledge(projectId, THREAD_A, false)
    expect(res.result).toBe(false)
    expect(await watermarkReason(projectId, THREAD_A)).toBeNull()
  })
})

describe("project boundary", () => {
  it("cannot watermark another project's thread by naming its id", async () => {
    // OWNER owns `projectId`. Aiming the action at a thread that lives in
    // otherProjectId must fail, and must not leave a record against either
    // project - the danger of the watermark is that it silently stops another
    // project from learning.
    const res = await purgeThreadKnowledge(projectId, THREAD_FOREIGN, false)

    expect(res.result).toBe(false)
    expect(await watermarkReason(projectId, THREAD_FOREIGN)).toBeNull()
    expect(await watermarkReason(otherProjectId, THREAD_FOREIGN)).toBeNull()
  })

  it("refuses it on the dry run too, so the error cannot be used to probe for a thread id", async () => {
    const res = await purgeThreadKnowledge(projectId, THREAD_FOREIGN, true)
    expect(res.result).toBe(false)
  })
})

describe("searchPurgeableThreads", () => {
  it("finds a thread with no knowledge at all - the one the default list cannot offer", async () => {
    const res = await searchPurgeableThreads(projectId, "leaked")
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.items).toHaveLength(1)
    expect(res.items[0]!.threadId).toBe(THREAD_A)
    expect(res.items[0]!.entryCount).toBe(0)
  })

  it("counts citing entries when there are some", async () => {
    await addEntry([{ threadId: THREAD_A }], "sole")
    await addEntry([{ threadId: THREAD_A }, { threadId: THREAD_B }], "multi")

    const res = await searchPurgeableThreads(projectId, "leaked")
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.items[0]!.entryCount).toBe(2)
  })

  it("never returns another project's thread", async () => {
    const res = await searchPurgeableThreads(projectId, "another project")
    expect(res.result).toBe(true)
    if (!res.result) return
    expect(res.items).toHaveLength(0)
  })

  it("refuses a write grant - it must not become a way to enumerate thread subjects", async () => {
    actingUserId = WRITER
    const res = await searchPurgeableThreads(projectId, "leaked")
    expect(res.result).toBe(false)
  })
})
