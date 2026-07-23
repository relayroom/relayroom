/**
 * One owner cannot hold the whole sweep batch (SRV-M2).
 *
 * The wake budget is per owner, but the eligibility sweep's batch is instance-wide,
 * and a budget-suppressed agent stays idle+unread - so it stays a candidate tick
 * after tick. Ordered by agent id (uuidv7, oldest first), one owner with enough
 * exhausted agents held every slot permanently, and a second owner with an
 * untouched budget was never even evaluated. Not a delay: budgets are isolated per
 * owner, so this was one tenant stopping another's wakes indefinitely.
 *
 * Measured before the fix: 5 ticks, 0 of 5 agents woken for the second owner, while
 * the same agent woke immediately when the batch was bypassed.
 *
 * Sizes come from SWEEP_BATCH so that changing the batch size cannot quietly turn
 * these tests into something that no longer exercises a full batch.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import {
  agents, messageRecipients, messages, ownerWakeBudgets, projects, threads, wakeIntents,
} from '@relayroom/db'
import postgres from 'postgres'
import { runEligibilitySweep, SWEEP_BATCH } from '../src/wake/sweep'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

/** Enough to fill the batch on its own, with room to spare. */
const HOGGING_AGENTS = SWEEP_BATCH + 5
const OTHER_AGENTS = 5

async function seedUser(id: string) {
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, ${id}, ${id + '@fair.test'}, true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING`
}

interface Fixture {
  hogIds: string[]
  otherIds: string[]
}

/**
 * An exhausted owner with a batch-filling number of agents, plus a second owner
 * with a healthy budget. The hogging owner's agents are created FIRST so their
 * uuidv7 ids sort ahead - the ordering that used to decide everything.
 */
async function twoOwners(): Promise<Fixture> {
  const sfx = randomBytes(5).toString('hex')
  const hog = `fair-hog-${sfx}`
  const other = `fair-other-${sfx}`
  await seedUser(hog)
  await seedUser(other)

  const [proj] = await db.insert(projects).values({
    organizationId: `fair-org-${sfx}`,
    slug: `fair-${sfx}`,
    name: 'Fairness',
    connectCode: `fair-cc-${sfx}`,
  }).returning({ id: projects.id })
  const projectId = proj!.id

  const [sender] = await db.insert(agents)
    .values({ projectId, part: `sender-${sfx}` }).returning({ id: agents.id })
  const [thread] = await db.insert(threads)
    .values({ projectId, subject: 'wake me', status: 'open' }).returning({ id: threads.id })

  async function candidate(part: string, owner: string): Promise<string> {
    const [a] = await db.insert(agents)
      .values({ projectId, part, ownerUserId: owner }).returning({ id: agents.id })
    const [m] = await db.insert(messages)
      .values({ threadId: thread!.id, fromAgentId: sender!.id, body: 'ping' })
      .returning({ id: messages.id })
    await db.insert(messageRecipients).values({ messageId: m!.id, agentId: a!.id })
    return a!.id
  }

  const hogIds: string[] = []
  for (let i = 0; i < HOGGING_AGENTS; i++) {
    hogIds.push(await candidate(`hog-${sfx}-${String(i).padStart(3, '0')}`, hog))
  }
  const otherIds: string[] = []
  for (let i = 0; i < OTHER_AGENTS; i++) {
    otherIds.push(await candidate(`other-${sfx}-${i}`, other))
  }

  // Spend the hogging owner's budget. The other owner has no row, so it gets the
  // defaults and can be woken.
  await db.insert(ownerWakeBudgets).values({ userId: hog, wakesPerHour: 0, urgentPerHour: 0 })

  return { hogIds, otherIds }
}

async function wokenCount(ids: string[]): Promise<number> {
  const rows = await db.select({ agentId: wakeIntents.agentId })
    .from(wakeIntents).where(inArray(wakeIntents.agentId, ids))
  return new Set(rows.map(r => r.agentId)).size
}

describe('sweep batch fairness across owners', () => {
  it('wakes the healthy owner even when another owner fills the batch', async () => {
    const { hogIds, otherIds } = await twoOwners()

    // One tick is enough: the healthy owner now holds slots in every batch.
    await runEligibilitySweep(db, bus)
    expect(await wokenCount(otherIds)).toBe(OTHER_AGENTS)

    // And the hogging owner is still capped by its budget, not by this change.
    // FLOOR_MIN means an exhausted owner still gets the project floor, so this is
    // "a few", never all of them.
    expect(await wokenCount(hogIds)).toBeLessThan(HOGGING_AGENTS)
  })

  it('keeps waking the healthy owner over repeated ticks', async () => {
    const { otherIds } = await twoOwners()
    for (let i = 0; i < 3; i++) await runEligibilitySweep(db, bus)
    expect(await wokenCount(otherIds)).toBe(OTHER_AGENTS)
  })

  it('still fills the batch, so fairness does not cost throughput', async () => {
    // The cap rounds UP (ceil(batch/owners)), so slots are not left empty just
    // because the batch does not divide evenly by the number of owners. With floor
    // division, 3 owners and a batch of 50 would top out at 48.
    const sfx = randomBytes(5).toString('hex')
    const solo = `fair-solo-${sfx}`
    await seedUser(solo)
    const [proj] = await db.insert(projects).values({
      organizationId: `solo-org-${sfx}`, slug: `solo-${sfx}`,
      name: 'Solo', connectCode: `solo-cc-${sfx}`,
    }).returning({ id: projects.id })
    const [sender] = await db.insert(agents)
      .values({ projectId: proj!.id, part: `s-${sfx}` }).returning({ id: agents.id })
    const [thread] = await db.insert(threads)
      .values({ projectId: proj!.id, subject: 'solo', status: 'open' })
      .returning({ id: threads.id })

    for (let i = 0; i < SWEEP_BATCH + 10; i++) {
      const [a] = await db.insert(agents)
        .values({ projectId: proj!.id, part: `solo-${sfx}-${i}`, ownerUserId: solo })
        .returning({ id: agents.id })
      const [m] = await db.insert(messages)
        .values({ threadId: thread!.id, fromAgentId: sender!.id, body: 'ping' })
        .returning({ id: messages.id })
      await db.insert(messageRecipients).values({ messageId: m!.id, agentId: a!.id })
    }

    const r = await runEligibilitySweep(db, bus)
    expect(r.candidates).toBe(SWEEP_BATCH)
  })

  it('leaves unowned agents out of the batch entirely', async () => {
    // shouldWake refuses an agent with no owner every time, so a slot spent on one
    // is a slot spent on nothing.
    const sfx = randomBytes(5).toString('hex')
    const [proj] = await db.insert(projects).values({
      organizationId: `orphan-org-${sfx}`, slug: `orphan-${sfx}`,
      name: 'Orphan', connectCode: `orphan-cc-${sfx}`,
    }).returning({ id: projects.id })
    const [sender] = await db.insert(agents)
      .values({ projectId: proj!.id, part: `os-${sfx}` }).returning({ id: agents.id })
    const [thread] = await db.insert(threads)
      .values({ projectId: proj!.id, subject: 'orphan', status: 'open' })
      .returning({ id: threads.id })
    const [orphan] = await db.insert(agents)
      .values({ projectId: proj!.id, part: `orphan-${sfx}` }) // no ownerUserId
      .returning({ id: agents.id })
    const [m] = await db.insert(messages)
      .values({ threadId: thread!.id, fromAgentId: sender!.id, body: 'ping' })
      .returning({ id: messages.id })
    await db.insert(messageRecipients).values({ messageId: m!.id, agentId: orphan!.id })

    const r = await runEligibilitySweep(db, bus, { agentId: orphan!.id })
    expect(r.candidates).toBe(0)
  })
})
