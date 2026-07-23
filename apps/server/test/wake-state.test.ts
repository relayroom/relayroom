import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '@relayroom/db'
import { agents, projects, wakeIntents } from '@relayroom/db'
import { ensurePending, expireStale, markDelivered, onActivation } from '../src/wake/state'

import { TEST_DATABASE_URL } from '../../../test/db-url'
const db = createDb(TEST_DATABASE_URL)

afterAll(async () => {
  await db.$client.end()
})

/** Create an isolated project + agent. Returns the agent row (with epoch/owner). */
async function makeAgent(part: string) {
  const orgId = `wake-org-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const slug = `wake-proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const [project] = await db.insert(projects)
    .values({ organizationId: orgId, slug, name: slug, connectCode: `cc-${slug}` })
    .returning()
  const [agent] = await db.insert(agents)
    .values({ projectId: project.id, part, ownerUserId: null })
    .returning()
  return agent
}

/** Read the single active wake for an agent (or undefined). */
async function activeWake(agentId: string) {
  const rows = await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, agentId))
  return rows.find(r => ['pending', 'delivered', 'activated'].includes(r.state))
}

describe('wake state machine: ensurePending coalescing', () => {
  it('first ensurePending creates a pending wake', async () => {
    const a = await makeAgent('coalesce-a')
    const r = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    expect(r.created).toBe(true)
    expect(r.intent.state).toBe('pending')
    expect(r.intent.epoch).toBe(a.activationEpoch)
  })

  it('second ensurePending while one is active is a NO-OP (coalesces onto existing)', async () => {
    const a = await makeAgent('coalesce-b')
    const first = await ensurePending(db, a.id, { epoch: a.activationEpoch, reason: 'message' })
    const second = await ensurePending(db, a.id, { epoch: a.activationEpoch, reason: 'message' })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    // Same row coalesced onto - the invariant: at most one active wake per agent.
    expect(second.intent.id).toBe(first.intent.id)
    const all = await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, a.id))
    const activeCount = all.filter(r => ['pending', 'delivered', 'activated'].includes(r.state)).length
    expect(activeCount).toBe(1)
  })

  it('after the active wake is settled, a new ensurePending creates a fresh wake', async () => {
    const a = await makeAgent('coalesce-c')
    const first = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    // Settle it via activation (epoch >= wake.epoch clears it).
    await onActivation(db, a.id, a.activationEpoch)
    const second = await ensurePending(db, a.id, { epoch: a.activationEpoch + 1 })
    expect(second.created).toBe(true)
    expect(second.intent.id).not.toBe(first.intent.id)
  })
})

describe('wake state machine: markDelivered', () => {
  it('pending -> delivered, stamps deliveredAt', async () => {
    const a = await makeAgent('deliver-a')
    const { intent } = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    const updated = await markDelivered(db, intent.wakeId)
    expect(updated).toBeDefined()
    expect(updated!.state).toBe('delivered')
    expect(updated!.deliveredAt).not.toBeNull()
  })

  it('is a no-op (returns undefined) when wake is not pending', async () => {
    const a = await makeAgent('deliver-b')
    const { intent } = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    await markDelivered(db, intent.wakeId)
    const again = await markDelivered(db, intent.wakeId) // already delivered
    expect(again).toBeUndefined()
  })
})

describe('wake state machine: onActivation epoch fencing', () => {
  it('activation with epoch >= wake.epoch clears the wake and advances watermark', async () => {
    const a = await makeAgent('act-a')
    const { intent } = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    const res = await onActivation(db, a.id, a.activationEpoch)
    expect(res.fenced).toBe(false)
    expect(res.cleared).toBeDefined()
    expect(res.cleared!.id).toBe(intent.id)
    expect(res.cleared!.state).toBe('done')
    expect(res.cleared!.settledAt).not.toBeNull()
    expect(res.activationEpoch).toBe(a.activationEpoch + 1)
    // watermark advanced
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, a.id))
    expect(agentRow.wakeWatermarkAt).not.toBeNull()
    // no active wake remains
    expect(await activeWake(a.id)).toBeUndefined()
  })

  it('STALE activation (epoch < wake.epoch) does NOT clear a newer wake', async () => {
    const a = await makeAgent('act-stale')
    // Create a wake targeting a FUTURE epoch (newer than the stale activation reports).
    const newerEpoch = a.activationEpoch + 5
    const { intent } = await ensurePending(db, a.id, { epoch: newerEpoch })
    // A stale activation arrives reporting the old epoch.
    const res = await onActivation(db, a.id, a.activationEpoch)
    expect(res.fenced).toBe(true)
    expect(res.cleared).toBeUndefined()
    // The newer wake is still active.
    const still = await activeWake(a.id)
    expect(still).toBeDefined()
    expect(still!.id).toBe(intent.id)
    expect(still!.state).toBe('pending')
    // activationEpoch still bumped (a turn really happened).
    expect(res.activationEpoch).toBe(a.activationEpoch + 1)
  })

  it('onActivation with no active wake just bumps activationEpoch (no clear)', async () => {
    const a = await makeAgent('act-none')
    const res = await onActivation(db, a.id, a.activationEpoch)
    expect(res.cleared).toBeUndefined()
    expect(res.fenced).toBe(false)
    expect(res.activationEpoch).toBe(a.activationEpoch + 1)
  })
})

describe('wake state machine: ack does NOT clear wake state (spec §4)', () => {
  it('marking a message read (ack) leaves the active wake intact; only onActivation clears it', async () => {
    const a = await makeAgent('ack-a')
    const { intent } = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    // Simulate ack: ack lives in mcp.ts and touches messageRecipients.readAt ONLY.
    // The wake module exposes NO ack entry point. Assert the wake is untouched by
    // anything short of onActivation: the active wake is still present here.
    const still = await activeWake(a.id)
    expect(still).toBeDefined()
    expect(still!.id).toBe(intent.id)
    expect(still!.state).toBe('pending')
    // The module surface must not export an ack-style clear. Guard against
    // accidental future additions that would let auto-ack resume the wake loop.
    const mod = await import('../src/wake/state')
    expect(Object.keys(mod)).not.toContain('ack')
    expect(Object.keys(mod)).not.toContain('onAck')
    expect(Object.keys(mod)).not.toContain('clearOnAck')
    // Only onActivation clears it.
    await onActivation(db, a.id, a.activationEpoch)
    expect(await activeWake(a.id)).toBeUndefined()
  })
})

describe('wake state machine: expireStale', () => {
  it('marks pending/delivered past expiresAt as expired and returns them', async () => {
    const a = await makeAgent('expire-a')
    const { intent } = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    // Force the row to be already expired.
    await db.update(wakeIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(wakeIntents.id, intent.id))
    const expired = await expireStale(db)
    expect(expired.map(r => r.id)).toContain(intent.id)
    const [row] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(row.state).toBe('expired')
    expect(await activeWake(a.id)).toBeUndefined()
  })

  it('does NOT expire a non-stale (future expiresAt) pending wake', async () => {
    const a = await makeAgent('expire-b')
    const { intent } = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    const expired = await expireStale(db)
    expect(expired.map(r => r.id)).not.toContain(intent.id)
    const still = await activeWake(a.id)
    expect(still).toBeDefined()
    expect(still!.state).toBe('pending')
  })

  it('does NOT expire an activated wake even if past expiresAt', async () => {
    const a = await makeAgent('expire-c')
    const { intent } = await ensurePending(db, a.id, { epoch: a.activationEpoch })
    await db.update(wakeIntents)
      .set({ state: 'activated', expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(wakeIntents.id, intent.id))
    const expired = await expireStale(db)
    expect(expired.map(r => r.id)).not.toContain(intent.id)
    const [row] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(row.state).toBe('activated')
  })
})
