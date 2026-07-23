/**
 * Limit-aware wake (park & resume). An agent self-reports a provider rate-limit
 * (agents.limitedUntil, set via the `event` MCP tool); while the window is in the
 * future, shouldWake suppresses with reason 'limited' (gate 2.5) WITHOUT reserving
 * budget, and the eligibility sweep resumes the part on its first tick after the
 * window passes. MCP-side set/clear/clamp behavior is covered in mcp.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
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
import { createBus } from '../src/bus'
import { shouldWake } from '../src/wake/issuance'
import { runEligibilitySweep } from '../src/wake/sweep'
import { ACTIVE_WAKE_STATES } from '../src/wake/state'

import { TEST_DATABASE_URL } from '../../../test/db-url'
const db: Db = createDb(TEST_DATABASE_URL)
const bus = createBus({ connectionString: TEST_DATABASE_URL })

const OWNER = 'user_owner_limited'
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

/** Seed one unread message addressed to the agent so the sweep sees a candidate. */
async function seedUnread(aid: string): Promise<void> {
  const [thread] = await db.insert(threads).values({ projectId, subject: 'park me' }).returning()
  const [msg] = await db.insert(messages).values({ threadId: thread.id, body: 'hello', recipientCount: 1 }).returning()
  await db.insert(messageRecipients).values({ messageId: msg.id, agentId: aid })
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
    .values({ organizationId: 'org_lim', slug: 'slim', name: 'PLim' })
    .returning()
  projectId = p.id
  await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 5, urgentPerHour: 2 })
  await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
  const [a] = await db.insert(agents).values({ projectId, part: 'alpha', ownerUserId: OWNER }).returning()
  agentId = a.id
})

afterAll(async () => {
  await bus.close()
  await db.$client.end()
})

describe('shouldWake - limited park (gate 2.5)', () => {
  it('suppresses with limited while limitedUntil is in the future; no intent, no budget consumed', async () => {
    await db.update(agents)
      .set({ limitedUntil: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(agents.id, agentId))

    const decision = await shouldWake(db, agentId, { reason: 'message', senderPart: 'beta' })
    expect(decision.action).toBe('suppress')
    if (decision.action === 'suppress') expect(decision.reason).toBe('limited')

    // no active wake_intent (a parked wake must not hold the coalescing slot)
    expect(await activeIntents(agentId)).toHaveLength(0)

    // audit row: suppressed=true, reason 'limited', and NOT an issued (budget) row
    const rows = await db.select().from(wakeEvents).where(eq(wakeEvents.agentId, agentId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.suppressed).toBe(true)
    expect(rows[0]!.reason).toBe('limited')
  })

  it('sweep re-checks do NOT write a suppress row per tick (unbounded-rows guard)', async () => {
    await db.update(agents)
      .set({ limitedUntil: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(agents.id, agentId))

    for (let i = 0; i < 3; i++) {
      const decision = await shouldWake(db, agentId, { reason: 'sweep' })
      expect(decision.action).toBe('suppress')
    }
    const rows = await db.select().from(wakeEvents).where(eq(wakeEvents.agentId, agentId))
    expect(rows).toHaveLength(0)
  })

  it('a past limitedUntil does not park - wake issues normally', async () => {
    await db.update(agents)
      .set({ limitedUntil: new Date(Date.now() - 1000) })
      .where(eq(agents.id, agentId))

    const decision = await shouldWake(db, agentId)
    expect(decision.action).toBe('issue')
    expect(await activeIntents(agentId)).toHaveLength(1)
  })

  it('park applies even with enforcement OFF (availability, not policy)', async () => {
    await db.update(agents)
      .set({ limitedUntil: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(agents.id, agentId))

    const decision = await shouldWake(db, agentId, { enforce: false })
    expect(decision.action).toBe('suppress')
    if (decision.action === 'suppress') expect(decision.reason).toBe('limited')
  })
})

describe('eligibility sweep - resume after the window passes', () => {
  it('parked part with unread is a candidate but not issued; after the window passes the sweep issues', async () => {
    await seedUnread(agentId)
    await db.update(agents)
      .set({ limitedUntil: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(agents.id, agentId))

    // While parked: candidate seen, nothing issued.
    const parked = await runEligibilitySweep(db, bus)
    expect(parked.candidates).toBe(1)
    expect(parked.issued).toBe(0)
    expect(await activeIntents(agentId)).toHaveLength(0)

    // Window passes (simulate by moving limitedUntil into the past - same as time
    // elapsing; the sweep re-evaluates every tick).
    await db.update(agents)
      .set({ limitedUntil: new Date(Date.now() - 1000) })
      .where(eq(agents.id, agentId))

    const resumed = await runEligibilitySweep(db, bus)
    expect(resumed.candidates).toBe(1)
    expect(resumed.issued).toBe(1)
    expect(await activeIntents(agentId)).toHaveLength(1)
  })
})
