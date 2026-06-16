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
import { shouldWake } from '../src/wake/issuance'
import { runEligibilitySweep } from '../src/wake/sweep'
import { ACTIVE_WAKE_STATES } from '../src/wake/state'

const TEST_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub_test'
const db: Db = createDb(TEST_DATABASE_URL)

const OWNER = 'user_owner_05'
let projectId: string
let agentId: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(authSchema.better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
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
  const [p] = await db
    .insert(projects)
    .values({ organizationId: 'org_05', slug: 's05', name: 'P05' })
    .returning()
  projectId = p.id
  await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 5, urgentPerHour: 2 })
  await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
  const [a] = await db.insert(agents).values({ projectId, part: 'alpha', ownerUserId: OWNER }).returning()
  agentId = a.id
})

afterAll(async () => {
  await db.$client.end()
})

describe('shouldWake - budget exhausted', () => {
  it('suppresses with budget_exhausted, writes a suppressed wake_event, creates no wake_intent', async () => {
    // Fill the rolling window to the cap (5).
    for (let i = 0; i < 5; i++) {
      await db.insert(wakeEvents).values({ ownerUserId: OWNER, agentId, projectId, suppressed: false })
    }
    const decision = await shouldWake(db, agentId)
    expect(decision.action).toBe('suppress')
    if (decision.action === 'suppress') expect(decision.reason).toBe('budget_exhausted')

    // no active wake_intent
    expect(await activeIntents(agentId)).toHaveLength(0)

    // exactly one suppressed audit row (in addition to the 5 seeded settled rows)
    const suppressedRows = await db
      .select({ id: wakeEvents.id })
      .from(wakeEvents)
      .where(and(eq(wakeEvents.agentId, agentId), eq(wakeEvents.suppressed, true)))
    expect(suppressedRows).toHaveLength(1)
  })
})

describe('shouldWake - issue path', () => {
  it('issues a wake + control wake_event when budget is available', async () => {
    const decision = await shouldWake(db, agentId, { reason: 'message' })
    expect(decision.action).toBe('issue')

    expect(await activeIntents(agentId)).toHaveLength(1)
    const events = await db
      .select({ suppressed: wakeEvents.suppressed, phantom: wakeEvents.phantom })
      .from(wakeEvents)
      .where(eq(wakeEvents.agentId, agentId))
    expect(events).toHaveLength(1)
    expect(events[0]!.suppressed).toBe(false)
    expect(events[0]!.phantom).toBe(false)
  })
})

describe('shouldWake - concurrency coalescing', () => {
  it('N concurrent calls produce exactly one active wake_intent, rest suppress idle_already_pending', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => shouldWake(db, agentId, { reason: 'message' })),
    )
    const issued = results.filter(r => r.action === 'issue')
    const coalesced = results.filter(
      r => r.action === 'suppress' && r.reason === 'idle_already_pending',
    )
    expect(issued).toHaveLength(1)
    expect(coalesced.length).toBe(results.length - 1)
    expect(await activeIntents(agentId)).toHaveLength(1)
  })
})

describe('runEligibilitySweep - refill recovery', () => {
  it('re-issues a suppressed idle part once the budget window frees up', async () => {
    // 1) seed an unread message addressed to alpha so it is an eligibility candidate.
    const [thread] = await db
      .insert(threads)
      .values({ projectId, subject: 'wake me' })
      .returning()
    const [msg] = await db
      .insert(messages)
      .values({ threadId: thread.id, body: 'hi', recipientCount: 1 })
      .returning()
    await db.insert(messageRecipients).values({ messageId: msg.id, agentId })

    // 2) exhaust the budget, attempt a wake -> suppressed (no intent).
    for (let i = 0; i < 5; i++) {
      await db.insert(wakeEvents).values({ ownerUserId: OWNER, agentId, projectId, suppressed: false })
    }
    const first = await shouldWake(db, agentId, { reason: 'message' })
    expect(first.action).toBe('suppress')
    expect(await activeIntents(agentId)).toHaveLength(0)

    // 3) free the window: remove the settled rows so the rolling count drops.
    await db
      .delete(wakeEvents)
      .where(and(eq(wakeEvents.agentId, agentId), eq(wakeEvents.suppressed, false)))

    // 4) sweep -> exactly one issue + one active intent + one bus.emit.
    const bus = { emit: vi.fn() }
    const res = await runEligibilitySweep(db, bus as never, { agentId })
    expect(res.issued).toBe(1)
    expect(await activeIntents(agentId)).toHaveLength(1)
    expect(bus.emit).toHaveBeenCalledTimes(1)
    const [, payload] = bus.emit.mock.calls[0]!
    expect(payload.wakeId).toBeTruthy()
  })
})
