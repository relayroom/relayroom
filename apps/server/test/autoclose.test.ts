/**
 * Idle-thread auto-close backstop (apps/server/src/wake/autoclose.ts).
 *
 * A still-active thread with no activity for the idle window is auto-closed so it
 * stops waking its participants. Fresh threads and already-closed threads are left
 * alone.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb, projects, threads } from '@relayroom/db'
import { autoCloseIdleThreads } from '../src/wake/autoclose'
import { TEST_DATABASE_URL } from './helpers'

const db = createDb(TEST_DATABASE_URL)

afterAll(async () => {
  await db.$client.end().catch(() => {})
})

async function makeProject(): Promise<string> {
  const [p] = await db.insert(projects).values({
    organizationId: `ac-org-${randomBytes(4).toString('hex')}`,
    slug: `ac-${randomBytes(4).toString('hex')}`,
    name: 'autoclose-test',
    connectCode: `ac-cc-${randomBytes(6).toString('hex')}`,
  }).returning({ id: projects.id })
  return p.id
}

describe('autoCloseIdleThreads', () => {
  it('closes idle active threads, leaves fresh and already-closed ones', async () => {
    const projectId = await makeProject()
    const old = new Date(Date.now() - 60 * 60_000) // 1 hour ago

    const [idle] = await db.insert(threads)
      .values({ projectId, subject: 'idle', status: 'open', createdAt: old })
      .returning({ id: threads.id })
    const [fresh] = await db.insert(threads)
      .values({ projectId, subject: 'fresh', status: 'open' }) // createdAt defaults to now
      .returning({ id: threads.id })
    const [done] = await db.insert(threads)
      .values({ projectId, subject: 'done', status: 'closed', createdAt: old })
      .returning({ id: threads.id })

    const closedCount = await autoCloseIdleThreads(db, 30 * 60_000) // 30 min window
    expect(closedCount).toBeGreaterThanOrEqual(1)

    const status = async (id: string) =>
      (await db.select({ s: threads.status }).from(threads).where(eq(threads.id, id)))[0]!.s

    expect(await status(idle.id)).toBe('closed') // idle -> auto-closed
    expect(await status(fresh.id)).toBe('open')  // fresh -> untouched
    expect(await status(done.id)).toBe('closed') // already closed -> untouched
  })

  it('is a no-op when there is nothing idle', async () => {
    const projectId = await makeProject()
    await db.insert(threads).values({ projectId, subject: 'recent', status: 'open' })
    // A 1-day window: the just-created thread is not idle, so nothing closes here.
    const projThreadsBefore = await db.select({ id: threads.id, s: threads.status })
      .from(threads).where(eq(threads.projectId, projectId))
    await autoCloseIdleThreads(db, 24 * 60 * 60_000)
    const projThreadsAfter = await db.select({ id: threads.id, s: threads.status })
      .from(threads).where(eq(threads.projectId, projectId))
    expect(projThreadsAfter).toEqual(projThreadsBefore)
  })
})
