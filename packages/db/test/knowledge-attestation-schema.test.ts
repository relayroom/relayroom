import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { getOrCreateProject } from '../src/bootstrap'
import { knowledge, knowledgeCheckMap, knowledgeNonces, projects } from '../src/schema'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

/** The driver wraps the server error, so the constraint name lives on the cause. */
async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err) {
    const parts = [String((err as Error).message)]
    for (let c = (err as { cause?: unknown }).cause; c; c = (c as { cause?: unknown }).cause) {
      parts.push(String((c as Error).message))
    }
    return parts.join(' | ')
  }
  throw new Error('expected the insert to be rejected')
}

/**
 * The L1 attestation schema is a trust boundary, so these assert the guarantees at
 * the database level rather than trusting each writer to remember them: a project
 * cannot map its CI check onto another project's claim, and a signed attestation
 * cannot be replayed. If the database stops enforcing either, a claim could become
 * trusted on evidence a project was never entitled to give.
 */
describe('knowledge attestation schema', () => {
  const seedKnowledge = async (slug: string) => {
    const project = await getOrCreateProject(db, slug)
    const [entry] = await db.insert(knowledge).values({
      projectId: project.id, kind: 'fact', title: 't', body: 'b', sourceKind: 'human',
    }).returning()
    return { project, entry: entry! }
  }

  it('gives every project the attest slots and an empty knowledge config', async () => {
    // The columns the promotion transaction and the attest endpoint read. Config
    // defaults to an empty object so "no override" is a value, not a null check.
    const project = await getOrCreateProject(db, 'ka-project-cols')
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(row!.attestSecret).toBeNull()
    expect(row!.attestKeyId).toBeNull()
    expect(row!.attestSecretPrev).toBeNull()
    expect(row!.attestKeyIdPrev).toBeNull()
    expect(row!.attestSecretPrevExpiresAt).toBeNull()
    expect(row!.knowledgeConfig).toEqual({})
  })

  it('stores a knowledge config the promotion transaction can read back', async () => {
    const project = await getOrCreateProject(db, 'ka-config')
    await db.update(projects)
      .set({ knowledgeConfig: { kDistinctIssuers: 3, windowDays: 45 } })
      .where(eq(projects.id, project.id))
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(row!.knowledgeConfig).toEqual({ kDistinctIssuers: 3, windowDays: 45 })
  })

  it('maps a check to a claim in the same project', async () => {
    const { project, entry } = await seedKnowledge('ka-map-ok')
    await db.insert(knowledgeCheckMap).values({
      projectId: project.id, checkName: 'migration-smoke', knowledgeId: entry.id,
    })
    const rows = await db.select().from(knowledgeCheckMap)
      .where(eq(knowledgeCheckMap.projectId, project.id))
    expect(rows).toHaveLength(1)
  })

  it('refuses to map a check onto another project\'s claim', async () => {
    // The tenant boundary, enforced by the composite FK rather than by app code. A
    // plain knowledge_id FK would accept this, because the id does exist - just not
    // in this project.
    const { entry } = await seedKnowledge('ka-map-owner')
    const attacker = await getOrCreateProject(db, 'ka-map-attacker')
    const err = await rejection(() => db.insert(knowledgeCheckMap).values({
      projectId: attacker.id, checkName: 'evil', knowledgeId: entry.id,
    }))
    expect(err).toContain('knowledge_check_map_tenant_fk')
  })

  it('drops a map row when the claim it points at is deleted', async () => {
    // ON DELETE cascade on the composite FK: a mapping cannot outlive its claim and
    // dangle onto a reused id.
    const { project, entry } = await seedKnowledge('ka-map-cascade')
    await db.insert(knowledgeCheckMap).values({
      projectId: project.id, checkName: 'smoke', knowledgeId: entry.id,
    })
    await db.delete(knowledge).where(eq(knowledge.id, entry.id))
    const rows = await db.select().from(knowledgeCheckMap)
      .where(eq(knowledgeCheckMap.projectId, project.id))
    expect(rows).toHaveLength(0)
  })

  it('rejects the same check mapped to the same claim twice', async () => {
    const { project, entry } = await seedKnowledge('ka-map-dedup')
    const row = { projectId: project.id, checkName: 'smoke', knowledgeId: entry.id }
    await db.insert(knowledgeCheckMap).values(row)
    const err = await rejection(() => db.insert(knowledgeCheckMap).values(row))
    expect(err).toContain('knowledge_check_map_uq')
  })

  it('blocks a replayed nonce within a project', async () => {
    // Replay defense: a signed attestation carries a nonce, and a second body with
    // the same (project, nonce) is the same request arriving twice.
    const project = await getOrCreateProject(db, 'ka-nonce-replay')
    await db.insert(knowledgeNonces).values({ projectId: project.id, nonce: 'n1' })
    const err = await rejection(() =>
      db.insert(knowledgeNonces).values({ projectId: project.id, nonce: 'n1' }))
    expect(err).toContain('knowledge_nonce')
  })

  it('lets two projects use the same nonce, because the key is per project', async () => {
    const a = await getOrCreateProject(db, 'ka-nonce-a')
    const b = await getOrCreateProject(db, 'ka-nonce-b')
    await db.insert(knowledgeNonces).values({ projectId: a.id, nonce: 'shared' })
    await db.insert(knowledgeNonces).values({ projectId: b.id, nonce: 'shared' })
    const count = await db.select({ n: sql<string>`count(*)` }).from(knowledgeNonces)
      .where(eq(knowledgeNonces.nonce, 'shared'))
    expect(Number(count[0]!.n)).toBe(2)
  })
})
