import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { createDb, type Db } from '@relayroom/db'
import {
  agents,
  authSchema,
  events,
  messageRecipients,
  messages,
  ownerWakeBudgets,
  projectAccess,
  projects,
  threads,
  wakeEvents,
  wakeIntents,
} from '@relayroom/db'
import { reconcileWakeLedger } from '../src/wake/reconcile'
import { ACTIVE_WAKE_STATES } from '../src/wake/state'
import { createApp } from '../src/app'
import { createBus } from '../src/bus'

import { TEST_DATABASE_URL } from '../../../test/db-url'
const db: Db = createDb(TEST_DATABASE_URL)

const OWNER = 'user_owner_05r'
let projectId: string
let connectCode: string
let agentId: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(authSchema.better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

beforeEach(async () => {
  await db.delete(wakeEvents)
  await db.delete(wakeIntents)
  await db.delete(events)
  await db.delete(messageRecipients)
  await db.delete(messages)
  await db.delete(threads)
  await db.delete(agents)
  await db.delete(projectAccess)
  await db.delete(ownerWakeBudgets)
  await db.delete(projects)
  await db.delete(authSchema.better_auth_user).where(eq(authSchema.better_auth_user.id, OWNER))

  await seedUser(OWNER)
  connectCode = `cc_05r_${Date.now()}`
  const [p] = await db
    .insert(projects)
    .values({ organizationId: 'org_05r', slug: 's05r', name: 'P05r', connectCode })
    .returning()
  projectId = p.id
  await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 30, urgentPerHour: 5 })
  await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
  const [a] = await db.insert(agents).values({ projectId, part: 'beta', ownerUserId: OWNER }).returning()
  agentId = a.id
})

afterAll(async () => {
  await db.$client.end()
})

describe('reconcileWakeLedger - phantom detection', () => {
  it('flags a real billed turn with no matching issued wake as phantom', async () => {
    const at = new Date()
    await db.insert(events).values({
      projectId,
      agentId,
      type: 'complete',
      usage: { input_tokens: 100, output_tokens: 50 },
      endedAt: at,
    })

    const res = await reconcileWakeLedger(db)
    expect(res.scanned).toBe(1)
    expect(res.phantomFlagged).toBe(1)

    const phantoms = await db
      .select({ ownerUserId: wakeEvents.ownerUserId })
      .from(wakeEvents)
      .where(and(eq(wakeEvents.agentId, agentId), eq(wakeEvents.phantom, true)))
    expect(phantoms).toHaveLength(1)
    expect(phantoms[0]!.ownerUserId).toBe(OWNER)
  })

  it('does NOT flag a turn that has a matching settled wake within the radius', async () => {
    const at = new Date()
    await db.insert(events).values({
      projectId,
      agentId,
      type: 'complete',
      usage: { input_tokens: 100 },
      endedAt: at,
    })
    // a settled (issued, non-suppressed, non-phantom) wake close in time
    await db.insert(wakeEvents).values({
      ownerUserId: OWNER,
      agentId,
      projectId,
      suppressed: false,
      phantom: false,
      createdAt: at,
    })

    const res = await reconcileWakeLedger(db)
    expect(res.phantomFlagged).toBe(0)
    const phantoms = await db
      .select({ id: wakeEvents.id })
      .from(wakeEvents)
      .where(and(eq(wakeEvents.agentId, agentId), eq(wakeEvents.phantom, true)))
    expect(phantoms).toHaveLength(0)
  })

  it('is idempotent across repeated runs (no duplicate phantom rows)', async () => {
    const at = new Date()
    await db.insert(events).values({
      projectId,
      agentId,
      type: 'complete',
      usage: { output_tokens: 200 },
      endedAt: at,
    })
    await reconcileWakeLedger(db)
    const second = await reconcileWakeLedger(db)
    expect(second.phantomFlagged).toBe(0)

    const phantoms = await db
      .select({ id: wakeEvents.id })
      .from(wakeEvents)
      .where(and(eq(wakeEvents.agentId, agentId), eq(wakeEvents.phantom, true)))
    expect(phantoms).toHaveLength(1)
  })

  it('ignores turns with zero tokens (not a billed turn)', async () => {
    await db.insert(events).values({
      projectId,
      agentId,
      type: 'complete',
      usage: { input_tokens: 0, output_tokens: 0 },
      endedAt: new Date(),
    })
    const res = await reconcileWakeLedger(db)
    expect(res.scanned).toBe(0)
    expect(res.phantomFlagged).toBe(0)
  })
})

describe('heartbeat eligibility trigger', () => {
  it('recovers a suppressed idle part on a single heartbeat', async () => {
    const bus = createBus({ connectionString: TEST_DATABASE_URL })
    const app = createApp(db, bus)

    // unread message for beta
    const [thread] = await db.insert(threads).values({ projectId, subject: 'ping' }).returning()
    const [msg] = await db
      .insert(messages)
      .values({ threadId: thread.id, body: 'hi', recipientCount: 1 })
      .returning()
    await db.insert(messageRecipients).values({ messageId: msg.id, agentId })

    // no active wake_intent yet (was suppressed); budget is available now.
    const before = await db
      .select({ id: wakeIntents.id })
      .from(wakeIntents)
      .where(and(eq(wakeIntents.agentId, agentId), inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[])))
    expect(before).toHaveLength(0)

    const res = await app.request(`/mcp/${connectCode}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'beta' }),
    })
    expect(res.status).toBe(200)

    // sweep is fire-and-forget; poll until the wake appears.
    let active: { id: string }[] = []
    for (let i = 0; i < 50; i++) {
      active = await db
        .select({ id: wakeIntents.id })
        .from(wakeIntents)
        .where(and(eq(wakeIntents.agentId, agentId), inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[])))
      if (active.length > 0) break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(active).toHaveLength(1)
    await bus.close()
  })
})
