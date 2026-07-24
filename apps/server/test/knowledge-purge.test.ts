/**
 * Purge knowledge derived from a thread (FEAT-0004 L3).
 *
 * The design decision this pins: sole-source entries are deleted, multi-source
 * entries are only detached, and dry-run counts exactly what a real purge would do
 * so the web preview and the delete cannot disagree.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { knowledge, projects } from '@relayroom/db'
import { purgeKnowledgeFromThread } from '../src/knowledge/purge'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'
import postgres from 'postgres'

const { db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

async function project(): Promise<string> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `pg-org-${sfx}`, slug: `pg-${sfx}`, name: 'Purge', connectCode: `pg-cc-${sfx}`,
  }).returning({ id: projects.id })
  return p!.id
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

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const THREAD_B = '22222222-2222-4222-8222-222222222222'

describe('purgeKnowledgeFromThread', () => {
  it('deletes an entry whose sole source was the thread', async () => {
    const p = await project()
    const sole = await entry(p, [{ threadId: THREAD_A }])
    const r = await purgeKnowledgeFromThread(db, p, THREAD_A)
    expect(r).toEqual({ deleted: 1, detached: 0 })
    expect(await exists(sole)).toBe(false)
  })

  it('detaches - not deletes - an entry that also cites another thread', async () => {
    const p = await project()
    const multi = await entry(p, [{ threadId: THREAD_A }, { threadId: THREAD_B }])
    const r = await purgeKnowledgeFromThread(db, p, THREAD_A)
    expect(r).toEqual({ deleted: 0, detached: 1 })
    expect(await exists(multi)).toBe(true)
    // A is gone from the ledger; B remains. No reference to A survives anywhere.
    expect(await refsOf(multi)).toEqual([{ threadId: THREAD_B }])
  })

  it('leaves no reference to the purged thread and loses no multi-source knowledge', async () => {
    const p = await project()
    const sole = await entry(p, [{ threadId: THREAD_A }])
    const multi = await entry(p, [{ threadId: THREAD_A }, { threadId: THREAD_B }])
    const unrelated = await entry(p, [{ threadId: THREAD_B }])

    const r = await purgeKnowledgeFromThread(db, p, THREAD_A)
    expect(r).toEqual({ deleted: 1, detached: 1 })
    expect(await exists(sole)).toBe(false)
    expect(await exists(multi)).toBe(true)
    expect(await exists(unrelated)).toBe(true)
    expect(await refsOf(unrelated)).toEqual([{ threadId: THREAD_B }])
  })

  it('dry-run counts exactly what a real purge would do, and writes nothing', async () => {
    const p = await project()
    const sole = await entry(p, [{ threadId: THREAD_A }])
    const multi = await entry(p, [{ threadId: THREAD_A }, { threadId: THREAD_B }])

    const preview = await purgeKnowledgeFromThread(db, p, THREAD_A, { dryRun: true })
    expect(preview).toEqual({ deleted: 1, detached: 1 })
    // Nothing changed.
    expect(await exists(sole)).toBe(true)
    expect(await exists(multi)).toBe(true)
    expect(await refsOf(multi)).toEqual([{ threadId: THREAD_A }, { threadId: THREAD_B }])

    // And a real purge matches the preview exactly.
    const real = await purgeKnowledgeFromThread(db, p, THREAD_A)
    expect(real).toEqual(preview)
  })

  it('does not touch another project\'s knowledge citing the same thread id', async () => {
    const a = await project()
    const b = await project()
    const mine = await entry(a, [{ threadId: THREAD_A }])
    const theirs = await entry(b, [{ threadId: THREAD_A }])
    const r = await purgeKnowledgeFromThread(db, a, THREAD_A)
    expect(r).toEqual({ deleted: 1, detached: 0 })
    expect(await exists(mine)).toBe(false)
    expect(await exists(theirs)).toBe(true)
  })
})
