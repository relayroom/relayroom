import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { getOrCreateAgent, getOrCreateProject } from '../src/bootstrap'
import {
  agents,
  messages,
  ownerWakeBudgets,
  projectAccess,
  threads,
  wakeIntents,
} from '../src/schema'
import { better_auth_user } from '../src/auth-schema'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

async function makeUser(id: string) {
  await db.insert(better_auth_user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: false,
  }).onConflictDoNothing()
}

describe('wake-budget schema', () => {
  it('owner_wake_budget defaults: 30 wakes/hr, 5 urgent/hr', async () => {
    const userId = 'wb-owner-defaults'
    await makeUser(userId)
    const [row] = await db.insert(ownerWakeBudgets)
      .values({ userId }).returning()
    expect(row.wakesPerHour).toBe(30)
    expect(row.urgentPerHour).toBe(5)
  })

  it('wake_intent coalescing: one active wake per agent enforced', async () => {
    const project = await getOrCreateProject(db, 'wb-coalesce')
    const agent = await getOrCreateAgent(db, project.id, 'wb-part-a')

    // First pending wake succeeds.
    await db.insert(wakeIntents).values({
      agentId: agent.id,
      projectId: project.id,
      state: 'pending',
      epoch: 0,
      expiresAt: new Date(Date.now() + 600_000),
    })

    // Second active (pending) wake for the same agent violates the partial unique index.
    await expect(
      db.insert(wakeIntents).values({
        agentId: agent.id,
        projectId: project.id,
        state: 'pending',
        epoch: 0,
        expiresAt: new Date(Date.now() + 600_000),
      }),
    ).rejects.toThrow()

    // Move the first to a terminal state, then a new pending wake is allowed.
    await db.update(wakeIntents)
      .set({ state: 'done' })
      .where(eq(wakeIntents.agentId, agent.id))

    const [next] = await db.insert(wakeIntents).values({
      agentId: agent.id,
      projectId: project.id,
      state: 'pending',
      epoch: 1,
      expiresAt: new Date(Date.now() + 600_000),
    }).returning()
    expect(next.state).toBe('pending')
  })

  it('project_access.bannedAt defaults null and is toggleable', async () => {
    const project = await getOrCreateProject(db, 'wb-ban')
    const userId = 'wb-ban-user'
    await makeUser(userId)
    const [row] = await db.insert(projectAccess).values({
      projectId: project.id,
      userId,
      level: 'write',
    }).returning()
    expect(row.bannedAt).toBeNull()
    expect(row.wakePriority).toBe(false)

    const now = new Date()
    const [banned] = await db.update(projectAccess)
      .set({ bannedAt: now })
      .where(eq(projectAccess.id, row.id))
      .returning()
    expect(banned.bannedAt).not.toBeNull()
  })

  it('messages.urgent/recipientCount default false/1', async () => {
    const project = await getOrCreateProject(db, 'wb-msg')
    const agent = await getOrCreateAgent(db, project.id, 'wb-part-msg')
    const [thread] = await db.insert(threads)
      .values({ projectId: project.id, subject: 'wb', createdByAgentId: agent.id })
      .returning()
    const [msg] = await db.insert(messages)
      .values({ threadId: thread.id, fromAgentId: agent.id, body: 'hi' })
      .returning()
    expect(msg.urgent).toBe(false)
    expect(msg.recipientCount).toBe(1)
  })

  it('agents.activationEpoch defaults 0', async () => {
    const project = await getOrCreateProject(db, 'wb-epoch')
    const agent = await getOrCreateAgent(db, project.id, 'wb-part-epoch')
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(row.activationEpoch).toBe(0)
  })
})
