/**
 * DB-level tests for agent role + soft-delete behaviour.
 *
 *  1. touchAgent (activity path) clears deleted_at on a soft-deleted part
 *     (revive), and refreshes last_seen_at.
 *  2. The `agent_project_user_main` partial unique index allows at most one
 *     'main' per (project, owner), while leaving non-main rows unconstrained and
 *     letting different owners each hold their own main.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { getOrCreateProject, getOrCreateAgent, touchAgent } from '../src/bootstrap'
import { agents } from '../src/schema'
import { better_auth_user } from '../src/auth-schema'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

// owner_user_id has an FK to better_auth_user, so owners must be seeded first.
async function seedUser(id: string): Promise<string> {
  await db
    .insert(better_auth_user)
    .values({ id, name: id, email: `${id}@role.test`, emailVerified: true })
    .onConflictDoNothing()
  return id
}

describe('touchAgent', () => {
  it('refreshes last_seen_at on a live part', async () => {
    const project = await getOrCreateProject(db, `role-touch-${Date.now()}`)
    const part = 'toucher'

    // touchAgent does not create (agents are born via the web UI / getOrCreateAgent);
    // it only bumps an existing row. Register the part first.
    const created = await getOrCreateAgent(db, project.id, part)
    expect(created.deletedAt).toBeNull()

    const past = new Date(Date.now() - 60 * 60 * 1000)
    await db.update(agents).set({ lastSeenAt: past }).where(eq(agents.id, created.id))

    const touched = await touchAgent(db, project.id, part)
    expect(touched.id).toBe(created.id) // same row, not a new one
    expect(touched.lastSeenAt!.getTime()).toBeGreaterThan(past.getTime())
  })

  it('does NOT revive a soft-deleted part', async () => {
    const project = await getOrCreateProject(db, `role-norevive-${Date.now()}`)
    const part = 'removed'

    const created = await getOrCreateAgent(db, project.id, part)
    const past = new Date(Date.now() - 60 * 60 * 1000)
    await db
      .update(agents)
      .set({ deletedAt: new Date(), lastSeenAt: past })
      .where(eq(agents.id, created.id))

    // A removed part's pager keeps beating; that traffic must not undo the removal.
    // touchAgent used to set deletedAt: null here, which brought the agent back.
    const touched = await touchAgent(db, project.id, part)
    expect(touched).toBeUndefined()

    const [after] = await db.select().from(agents).where(eq(agents.id, created.id))
    expect(after!.deletedAt).not.toBeNull()
    expect(after!.lastSeenAt!.getTime()).toBe(past.getTime()) // not even touched
  })
})

describe('agent_project_user_main partial unique index', () => {
  it('rejects a second main for the same (project, owner)', async () => {
    const project = await getOrCreateProject(db, `role-main-${Date.now()}`)
    const owner = await seedUser(`role-owner-${Date.now()}`)

    await db.insert(agents).values({ projectId: project.id, part: 'backend', role: 'main', ownerUserId: owner })

    // A second 'main' for the same (project, owner) violates the partial index.
    await expect(
      db.insert(agents).values({ projectId: project.id, part: 'frontend', role: 'main', ownerUserId: owner }),
    ).rejects.toThrow()
  })

  it('allows many non-main agents for the same (project, owner)', async () => {
    const project = await getOrCreateProject(db, `role-default-${Date.now()}`)
    const owner = await seedUser(`role-owner-d-${Date.now()}`)
    await db.insert(agents).values({ projectId: project.id, part: 'a', role: 'default', ownerUserId: owner })
    await db.insert(agents).values({ projectId: project.id, part: 'b', role: 'default', ownerUserId: owner })
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, project.id), eq(agents.ownerUserId, owner)))
    expect(rows.length).toBe(2)
  })

  it('allows different owners to each hold their own main', async () => {
    const project = await getOrCreateProject(db, `role-twoowners-${Date.now()}`)
    const ownerA = await seedUser(`role-owner-a-${Date.now()}`)
    const ownerB = await seedUser(`role-owner-b-${Date.now()}-b`)
    await db.insert(agents).values({ projectId: project.id, part: 'a-main', role: 'main', ownerUserId: ownerA })
    await db.insert(agents).values({ projectId: project.id, part: 'b-main', role: 'main', ownerUserId: ownerB })
    const mains = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, project.id), eq(agents.role, 'main'), isNull(agents.deletedAt)))
    expect(mains.length).toBe(2)
  })
})
