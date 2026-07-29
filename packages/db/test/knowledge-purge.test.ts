import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { PurgeProjectMismatchError, purgeKnowledgeFromThread } from '../src/knowledge'
import { knowledge, knowledgeAudits, projects, threadExtractions, threads } from '../src/schema'
import { better_auth_user } from '../src/auth-schema'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

/**
 * Purging "knowledge derived from thread X" has to respect that sourceRefs is an
 * array: an entry can be distilled from several threads. So these pin the split the
 * design requires - sole-source entries deleted, multi-source entries only detached
 * - and that a dry run counts exactly what a real purge does, since the dashboard
 * preview and the irreversible delete are the same function.
 *
 * BUG-0010 added three things these also pin: the watermark that makes a purge
 * durable against re-extraction, the audit row that makes a purge visible at all,
 * and the project-boundary check that was previously vacuous.
 */

// The purge audit FKs actor_user_id to a real better_auth_user.
const USER = `usr-purge-${randomBytes(4).toString('hex')}`
beforeAll(async () => {
  await db.insert(better_auth_user)
    .values({ id: USER, name: 'Purge Tester', email: `${USER}@test.local` })
    .onConflictDoNothing()
})

async function project(): Promise<string> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `pg-org-${sfx}`, slug: `pg-${sfx}`, name: 'Purge', connectCode: `pg-cc-${sfx}`,
  }).returning({ id: projects.id })
  return p!.id
}

/** A real thread row: the purge now checks membership, so fixtures cannot invent ids. */
async function thread(projectId: string): Promise<string> {
  const [t] = await db.insert(threads).values({
    projectId, subject: `t-${randomBytes(3).toString('hex')}`, status: 'closed',
  }).returning({ id: threads.id })
  return t!.id
}

async function entry(projectId: string, sourceRefs: { threadId?: string; eventId?: string }[]): Promise<string> {
  const [k] = await db.insert(knowledge).values({
    projectId, kind: 'fact', title: `k-${randomBytes(3).toString('hex')}`, body: 'b',
    sourceKind: 'proposer', validationState: 'candidate', sourceRefs,
  }).returning({ id: knowledge.id })
  return k!.id
}

async function exists(id: string): Promise<boolean> {
  const [row] = await db.select({ id: knowledge.id }).from(knowledge).where(eq(knowledge.id, id))
  return !!row
}

async function refsOf(id: string) {
  const [row] = await db.select({ r: knowledge.sourceRefs }).from(knowledge).where(eq(knowledge.id, id))
  return row!.r
}

async function watermark(projectId: string, threadId: string): Promise<string | null> {
  const [row] = await db.select({ reason: threadExtractions.reason }).from(threadExtractions)
    .where(and(eq(threadExtractions.projectId, projectId), eq(threadExtractions.threadId, threadId)))
  return row?.reason ?? null
}

async function auditsFor(projectId: string) {
  return db.select().from(knowledgeAudits).where(eq(knowledgeAudits.projectId, projectId))
}

describe('purgeKnowledgeFromThread', () => {
  it('deletes an entry whose sole source was the thread', async () => {
    const p = await project()
    const a = await thread(p)
    const sole = await entry(p, [{ threadId: a }])
    const r = await purgeKnowledgeFromThread(db, p, a, { actorUserId: USER })
    expect(r).toEqual({ deleted: 1, detached: 0 })
    expect(await exists(sole)).toBe(false)
  })

  it('detaches - not deletes - an entry that also cites another thread', async () => {
    const p = await project()
    const a = await thread(p)
    const b = await thread(p)
    const multi = await entry(p, [{ threadId: a }, { threadId: b }])
    const r = await purgeKnowledgeFromThread(db, p, a, { actorUserId: USER })
    expect(r).toEqual({ deleted: 0, detached: 1 })
    expect(await exists(multi)).toBe(true)
    expect(await refsOf(multi)).toEqual([{ threadId: b }])
  })

  it('a dry run counts what a real purge would do and writes nothing', async () => {
    const p = await project()
    const a = await thread(p)
    const b = await thread(p)
    const sole = await entry(p, [{ threadId: a }])
    const multi = await entry(p, [{ threadId: a }, { threadId: b }])

    const preview = await purgeKnowledgeFromThread(db, p, a, { dryRun: true })
    expect(preview).toEqual({ deleted: 1, detached: 1 })
    expect(await exists(sole)).toBe(true)
    expect(await refsOf(multi)).toEqual([{ threadId: a }, { threadId: b }])

    const real = await purgeKnowledgeFromThread(db, p, a, { actorUserId: USER })
    expect(real).toEqual(preview)
  })

  // ── BUG-0010 ────────────────────────────────────────────────────────────────

  it('writes a purged watermark, so the suppression outlives the row it deleted', async () => {
    const p = await project()
    const a = await thread(p)
    await entry(p, [{ threadId: a }])
    await purgeKnowledgeFromThread(db, p, a, { actorUserId: USER })
    expect(await watermark(p, a)).toBe('purged')
  })

  it('writes the watermark even when the thread produced no knowledge at all', async () => {
    // An operator purging a thread means "do not extract this", whether or not we
    // happened to have extracted it yet. Without this, the remedy for a thread that
    // was purged BEFORE the watermark existed would still do nothing.
    const p = await project()
    const a = await thread(p)
    const r = await purgeKnowledgeFromThread(db, p, a, { actorUserId: USER })
    expect(r).toEqual({ deleted: 0, detached: 0 })
    expect(await watermark(p, a)).toBe('purged')
  })

  it('purged overwrites an existing extracted watermark', async () => {
    const p = await project()
    const a = await thread(p)
    await db.insert(threadExtractions).values({ projectId: p, threadId: a, reason: 'extracted' })
    await purgeKnowledgeFromThread(db, p, a, { actorUserId: USER })
    expect(await watermark(p, a)).toBe('purged')
  })

  it('NEGATIVE CONTROL: a dry run writes neither watermark nor audit', async () => {
    // The dashboard dry-runs to fill in its confirmation dialog. A preview that left
    // a watermark would suppress extraction for a thread the owner then declined to
    // purge - a destructive preview.
    const p = await project()
    const a = await thread(p)
    await entry(p, [{ threadId: a }])
    await purgeKnowledgeFromThread(db, p, a, { dryRun: true })
    expect(await watermark(p, a)).toBeNull()
    expect(await auditsFor(p)).toHaveLength(0)
  })

  it('writes one audit row naming the thread, the actor and both counts', async () => {
    const p = await project()
    const a = await thread(p)
    const b = await thread(p)
    await entry(p, [{ threadId: a }])
    await entry(p, [{ threadId: a }, { threadId: b }])

    await purgeKnowledgeFromThread(db, p, a, { actorUserId: USER })

    const rows = await auditsFor(p)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('purge')
    expect(rows[0]!.knowledgeId).toBeNull()
    expect(rows[0]!.actorKind).toBe('human')
    expect(rows[0]!.actorUserId).toBe(USER)
    // Separate counts: a deleted row is gone, a detached one still exists with one
    // fewer source. Collapsing them destroys the distinction where it is recorded.
    expect(rows[0]!.detail).toMatchObject({ threadId: a, deleted: 1, detached: 1 })
  })

  it('refuses a thread from another project, and writes nothing', async () => {
    // Before the watermark this check was vacuous: the scan is project-scoped, so a
    // foreign thread matched no rows and nothing happened. Now the function WRITES a
    // row keyed by (project, thread), so an unchecked call could mark another
    // project's thread "do not extract" - silently, and invisibly to its owner.
    const victim = await project()
    const attacker = await project()
    const victimThread = await thread(victim)

    // A distinct error type with a stable code, so the dashboard can say "that thread
    // is not in this project" without matching on message text.
    await expect(purgeKnowledgeFromThread(db, attacker, victimThread, { actorUserId: USER }))
      .rejects.toThrow(PurgeProjectMismatchError)
    await expect(purgeKnowledgeFromThread(db, attacker, victimThread, { actorUserId: USER }))
      .rejects.toMatchObject({ code: 'purge_project_mismatch' })

    expect(await watermark(attacker, victimThread)).toBeNull()
    expect(await watermark(victim, victimThread)).toBeNull()
    expect(await auditsFor(attacker)).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: a dry run for a foreign thread is refused too', async () => {
    // Otherwise a probe could confirm whether a thread id exists in another project
    // by whether it errors, and the boundary would only apply to writes.
    const victim = await project()
    const attacker = await project()
    const victimThread = await thread(victim)
    await expect(purgeKnowledgeFromThread(db, attacker, victimThread, { dryRun: true }))
      .rejects.toThrow(PurgeProjectMismatchError)
  })
})
