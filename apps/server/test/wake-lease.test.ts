import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '@relayroom/db'
import { agents, messageRecipients, messages, projects, threads, wakeIntents } from '@relayroom/db'
import { ensurePending } from '../src/wake/state'
import {
  claimLease,
  decidePendingWake,
  markDeliveredFenced,
  releaseLease,
  renewLease,
} from '../src/lib/wake-lease'

const TEST_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub_test'
const db = createDb(TEST_DATABASE_URL)

afterAll(async () => {
  await db.$client.end()
})

/** Create an isolated project + agent. */
async function makeAgent(part: string) {
  const orgId = `lease-org-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const slug = `lease-proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const [project] = await db.insert(projects)
    .values({ organizationId: orgId, slug, name: slug, connectCode: `cc-${slug}` })
    .returning()
  const [agent] = await db.insert(agents)
    .values({ projectId: project.id, part, ownerUserId: null })
    .returning()
  return { agent, project }
}

/** Seed N unread messages to an agent from a freshly created sender agent. */
async function seedUnread(projectId: string, toAgentId: string, n: number, fromPart = 'sender') {
  const [fromAgent] = await db.insert(agents)
    .values({ projectId, part: `${fromPart}-${Math.random().toString(36).slice(2, 6)}` })
    .returning()
  for (let i = 0; i < n; i++) {
    const [thread] = await db.insert(threads)
      .values({ projectId, subject: `subject-${i}` })
      .returning()
    const [msg] = await db.insert(messages)
      .values({ threadId: thread.id, fromAgentId: fromAgent.id, body: `body-${i}` })
      .returning()
    await db.insert(messageRecipients).values({ messageId: msg.id, agentId: toAgentId })
  }
  return fromAgent
}

describe('wake-lease: claimLease / renewLease / releaseLease', () => {
  it('first claim succeeds, sets holder + future expiry, returns active wakeId', async () => {
    const { agent } = await makeAgent('lease-a')
    const { intent } = await ensurePending(db, agent.id, { epoch: agent.activationEpoch })
    const r = await claimLease(db, { agentId: agent.id, holder: 'm1' })
    expect(r.ok).toBe(true)
    expect(r.wakeId).toBe(intent.wakeId)
    const [row] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(row.leaseHolder).toBe('m1')
    expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30_000)
  })

  it('second claimant is REFUSED while a live lease is held by another holder', async () => {
    const { agent } = await makeAgent('lease-b')
    await ensurePending(db, agent.id, { epoch: agent.activationEpoch })
    const first = await claimLease(db, { agentId: agent.id, holder: 'm1' })
    expect(first.ok).toBe(true)
    const second = await claimLease(db, { agentId: agent.id, holder: 'm2' })
    expect(second.ok).toBe(false)
    expect(second.held).toBe(true)
    expect(second.holder).toBe('m1')
  })

  it('an expired lease is reclaimable by a new holder', async () => {
    const { agent } = await makeAgent('lease-c')
    const { intent } = await ensurePending(db, agent.id, { epoch: agent.activationEpoch })
    await claimLease(db, { agentId: agent.id, holder: 'm1' })
    // Force the lease into the past.
    await db.update(wakeIntents)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(wakeIntents.id, intent.id))
    const r = await claimLease(db, { agentId: agent.id, holder: 'm2' })
    expect(r.ok).toBe(true)
    expect(r.wakeId).toBe(intent.wakeId)
    const [row] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(row.leaseHolder).toBe('m2')
  })

  it('claim when no active wake exists returns noWake', async () => {
    const { agent } = await makeAgent('lease-d')
    const r = await claimLease(db, { agentId: agent.id, holder: 'm1' })
    expect(r.ok).toBe(false)
    expect(r.noWake).toBe(true)
  })

  it('renew by a holder that has lost the lease returns ok:false (lease loss detected)', async () => {
    const { agent } = await makeAgent('lease-e')
    await ensurePending(db, agent.id, { epoch: agent.activationEpoch })
    await claimLease(db, { agentId: agent.id, holder: 'm1' })
    // m2 takes over by expiring m1's lease then claiming.
    await db.update(wakeIntents)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(wakeIntents.agentId, agent.id))
    await claimLease(db, { agentId: agent.id, holder: 'm2' })
    const r = await renewLease(db, { agentId: agent.id, holder: 'm1' })
    expect(r.ok).toBe(false)
  })

  it('release clears the lease only when held by the caller', async () => {
    const { agent } = await makeAgent('lease-f')
    const { intent } = await ensurePending(db, agent.id, { epoch: agent.activationEpoch })
    await claimLease(db, { agentId: agent.id, holder: 'm1' })
    await releaseLease(db, { agentId: agent.id, holder: 'm2' }) // not the holder: no-op
    let [row] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(row.leaseHolder).toBe('m1')
    await releaseLease(db, { agentId: agent.id, holder: 'm1' })
    ;[row] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(row.leaseHolder).toBeNull()
  })
})

describe('wake-lease: markDeliveredFenced (wakeId fencing)', () => {
  it('marks the matching active wake delivered', async () => {
    const { agent } = await makeAgent('fence-a')
    const { intent } = await ensurePending(db, agent.id, { epoch: agent.activationEpoch })
    const r = await markDeliveredFenced(db, { agentId: agent.id, wakeId: intent.wakeId })
    expect(r.ok).toBe(true)
    const [row] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(row.state).toBe('delivered')
    expect(row.deliveredAt).not.toBeNull()
  })

  it('ignores a stale wakeId (no state change)', async () => {
    const { agent } = await makeAgent('fence-b')
    const { intent } = await ensurePending(db, agent.id, { epoch: agent.activationEpoch })
    const r = await markDeliveredFenced(db, { agentId: agent.id, wakeId: '00000000-0000-0000-0000-000000000000' })
    expect(r.ok).toBe(false)
    expect(r.stale).toBe(true)
    const [row] = await db.select().from(wakeIntents).where(eq(wakeIntents.id, intent.id))
    expect(row.state).toBe('pending')
  })

  it('re-reporting an already-delivered wakeId is an idempotent ok (already)', async () => {
    const { agent } = await makeAgent('fence-c')
    const { intent } = await ensurePending(db, agent.id, { epoch: agent.activationEpoch })
    await markDeliveredFenced(db, { agentId: agent.id, wakeId: intent.wakeId })
    const again = await markDeliveredFenced(db, { agentId: agent.id, wakeId: intent.wakeId })
    expect(again.ok).toBe(true)
    expect(again.already).toBe(true)
  })
})

describe('wake-lease: decidePendingWake (catch-up coalesce)', () => {
  // Always-allow issue stub: bypasses budget, just ensures a coalesced wake row.
  const allowIssue = async (agentId: string) => {
    const { agent } = { agent: { activationEpoch: 0 } }
    void agent
    const { intent } = await ensurePending(db, agentId, { epoch: 0, reason: 'catchup' })
    return { wakeId: intent.wakeId }
  }

  it('with unread and no active wake, issues exactly ONE coalesced wake', async () => {
    const { agent, project } = await makeAgent('catch-a')
    await seedUnread(project.id, agent.id, 3)
    const d = await decidePendingWake(db, { agentId: agent.id, issue: allowIssue })
    expect(d.wake).toBe(true)
    expect(d.count).toBe(3)
    const active = (await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, agent.id)))
      .filter(r => ['pending', 'delivered', 'activated'].includes(r.state))
    expect(active.length).toBe(1)
  })

  it('a second call returns the SAME wakeId without creating a new row', async () => {
    const { agent, project } = await makeAgent('catch-b')
    await seedUnread(project.id, agent.id, 2)
    const first = await decidePendingWake(db, { agentId: agent.id, issue: allowIssue })
    const second = await decidePendingWake(db, { agentId: agent.id, issue: allowIssue })
    expect(second.wake).toBe(true)
    expect(second.wakeId).toBe(first.wakeId)
    const active = (await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, agent.id)))
      .filter(r => ['pending', 'delivered', 'activated'].includes(r.state))
    expect(active.length).toBe(1)
  })

  it('no unread => wake:false, no row created', async () => {
    const { agent } = await makeAgent('catch-c')
    const d = await decidePendingWake(db, { agentId: agent.id, issue: allowIssue })
    expect(d.wake).toBe(false)
    const rows = await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, agent.id))
    expect(rows.length).toBe(0)
  })

  it('active wake but caught up (0 unread) => settles the wake and returns wake:false', async () => {
    // The bug: an active wake with nothing unread was re-delivered forever (the
    // agent read an empty inbox, which never settled the wake). decidePendingWake
    // must now settle it and stop waking.
    const { agent } = await makeAgent('catch-stale')
    await ensurePending(db, agent.id, { epoch: 0, reason: 'catchup' }) // active, no unread
    const active = (await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, agent.id)))
      .filter(r => ['pending', 'delivered', 'activated'].includes(r.state))
    expect(active.length).toBe(1)

    const d = await decidePendingWake(db, { agentId: agent.id, issue: allowIssue })
    expect(d.wake).toBe(false)

    const stillActive = (await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, agent.id)))
      .filter(r => ['pending', 'delivered', 'activated'].includes(r.state))
    expect(stillActive.length).toBe(0) // settled to 'done'
  })

  it('budget-suppressed issue => wake:false suppressed, no row created', async () => {
    const { agent, project } = await makeAgent('catch-d')
    await seedUnread(project.id, agent.id, 1)
    const suppressIssue = async () => ({ suppressed: true as const })
    const d = await decidePendingWake(db, { agentId: agent.id, issue: suppressIssue })
    expect(d.wake).toBe(false)
    expect(d.suppressed).toBe(true)
    const rows = await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, agent.id))
    expect(rows.length).toBe(0)
  })
})
