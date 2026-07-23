import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { createDb, type Db } from '@relayroom/db'
import {
  agents,
  authSchema,
  messageRecipients,
  messages,
  ownerWakeBudgets,
  projectAccess,
  projects,
  threads,
  wakeEvents,
  wakeIntents,
} from '@relayroom/db'
import { runEligibilitySweep } from '../src/wake/sweep'
import { ensurePending, ACTIVE_WAKE_STATES } from '../src/wake/state'

import { TEST_DATABASE_URL } from '../../../test/db-url'
const db: Db = createDb(TEST_DATABASE_URL)

const OWNER = 'user_owner_05s'
let projectId: string
let agentId: string

function fakeBus() {
  return { emit: vi.fn() }
}

async function seedUser(id: string): Promise<void> {
  await db
    .insert(authSchema.better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function unreadFor(aid: string, subject = 'hi'): Promise<void> {
  const [thread] = await db.insert(threads).values({ projectId, subject }).returning()
  const [msg] = await db
    .insert(messages)
    .values({ threadId: thread.id, body: 'b', recipientCount: 1 })
    .returning()
  await db.insert(messageRecipients).values({ messageId: msg.id, agentId: aid })
}

async function activeIntents(aid: string) {
  return db
    .select({ id: wakeIntents.id })
    .from(wakeIntents)
    .where(and(eq(wakeIntents.agentId, aid), inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[])))
}

beforeEach(async () => {
  await db.delete(wakeEvents)
  await db.delete(wakeIntents)
  await db.delete(messageRecipients)
  await db.delete(messages)
  await db.delete(threads)
  await db.delete(agents)
  await db.delete(projectAccess)
  await db.delete(ownerWakeBudgets)
  await db.delete(projects)
  await db.delete(authSchema.better_auth_user).where(eq(authSchema.better_auth_user.id, OWNER))

  await seedUser(OWNER)
  const [p] = await db.insert(projects).values({ organizationId: 'org_05s', slug: 's05s', name: 'P05s' }).returning()
  projectId = p.id
  await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 30, urgentPerHour: 5 })
  await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
  const [a] = await db.insert(agents).values({ projectId, part: 'gamma', ownerUserId: OWNER }).returning()
  agentId = a.id
})

afterAll(async () => {
  await db.$client.end()
})

describe('runEligibilitySweep - candidate selection', () => {
  it('issues a wake for an idle part with pending unread + available budget', async () => {
    await unreadFor(agentId)
    const bus = fakeBus()
    const res = await runEligibilitySweep(db, bus as never)
    expect(res.candidates).toBe(1)
    expect(res.issued).toBe(1)
    expect(await activeIntents(agentId)).toHaveLength(1)
    expect(bus.emit).toHaveBeenCalledTimes(1)
  })

  it('skips a part that already has an active wake (coalescing)', async () => {
    await unreadFor(agentId)
    await ensurePending(db, agentId, { epoch: 0, reason: 'message' })
    const bus = fakeBus()
    const res = await runEligibilitySweep(db, bus as never)
    expect(res.candidates).toBe(0)
    expect(res.issued).toBe(0)
    expect(bus.emit).not.toHaveBeenCalled()
    expect(await activeIntents(agentId)).toHaveLength(1)
  })

  it('skips a part with no pending unread', async () => {
    const bus = fakeBus()
    const res = await runEligibilitySweep(db, bus as never)
    expect(res.candidates).toBe(0)
    expect(res.issued).toBe(0)
  })

  it('skips unread that predates the agent wakeWatermarkAt', async () => {
    await unreadFor(agentId)
    // advance watermark to now so the older message no longer counts.
    await db.update(agents).set({ wakeWatermarkAt: new Date(Date.now() + 1000) }).where(eq(agents.id, agentId))
    const bus = fakeBus()
    const res = await runEligibilitySweep(db, bus as never)
    expect(res.candidates).toBe(0)
  })

  it('honors opts.agentId to scope the sweep to one part', async () => {
    const [other] = await db.insert(agents).values({ projectId, part: 'delta', ownerUserId: OWNER }).returning()
    await unreadFor(agentId)
    await unreadFor(other.id)
    const bus = fakeBus()
    const res = await runEligibilitySweep(db, bus as never, { agentId })
    expect(res.candidates).toBe(1)
    expect(await activeIntents(agentId)).toHaveLength(1)
    expect(await activeIntents(other.id)).toHaveLength(0)
  })
})
