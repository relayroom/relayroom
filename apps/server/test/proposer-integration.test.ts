/**
 * Proposer end-to-end against the REAL core proposeKnowledgeDiff (FEAT-0005 L4).
 *
 * proposer.test.ts drives the sweep with an injected fake to pin its logic; this
 * pins the wiring: a clustered signature lands as exactly ONE pending knowledge
 * proposal in the actual knowledge_proposal table, a re-run does not double-queue it
 * (the open-signature partial unique index dedupes), and a contradicted entry lands
 * as its own pending pitfall proposal.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { agents, events, knowledge, knowledgeProposals, projects, proposeKnowledgeDiff } from '@relayroom/db'
import { runProposerSweep } from '../src/knowledge/proposer'
import { makeTestApp } from './helpers'

const { db, bus } = makeTestApp()

afterAll(async () => {
  await bus.close()
  await db.$client.end()
})

async function project(): Promise<{ id: string }> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `pi-org-${sfx}`, slug: `pi-${sfx}`, name: 'ProposerE2E', connectCode: `pi-cc-${sfx}`,
  }).returning({ id: projects.id })
  return { id: p!.id }
}

async function agent(projectId: string): Promise<string> {
  const [a] = await db.insert(agents).values({ projectId, part: `p${randomBytes(3).toString('hex')}` })
    .returning({ id: agents.id })
  return a!.id
}

async function proposalsFor(projectId: string) {
  return db.select().from(knowledgeProposals).where(eq(knowledgeProposals.projectId, projectId))
}

describe('proposer + proposeKnowledgeDiff (e2e)', () => {
  it('a clustered signature becomes exactly one pending proposal; a re-run does not double-queue', async () => {
    const p = await project()
    const a1 = await agent(p.id)
    const a2 = await agent(p.id)
    await db.insert(events).values({ projectId: p.id, agentId: a1, type: 'error', detail: { code: 'E_E2E', area: 'db' } })
    await db.insert(events).values({ projectId: p.id, agentId: a2, type: 'error', detail: { code: 'E_E2E', area: 'db' } })

    const r1 = await runProposerSweep(db, { propose: proposeKnowledgeDiff, projectId: p.id })
    expect(r1.proposals).toBe(1)

    const after1 = await proposalsFor(p.id)
    expect(after1).toHaveLength(1)
    const row = after1[0]!
    expect(row.status).toBe('pending')
    expect(row.target).toBe('knowledge')
    expect((row.change as { kind?: string }).kind).toBe('pitfall')
    expect(row.evidence.agents).toBe(2)
    expect(row.triggerSignature).toMatch(/^[0-9a-f]{64}$/)

    // Re-run: the open-signature partial unique index makes it a silent no-op.
    const r2 = await runProposerSweep(db, { propose: proposeKnowledgeDiff, projectId: p.id })
    expect(r2.proposals).toBe(0)
    expect(await proposalsFor(p.id)).toHaveLength(1)
  })

  it('a contradicted entry becomes its own pending pitfall proposal', async () => {
    const p = await project()
    await db.insert(knowledge).values({
      projectId: p.id, kind: 'convention', title: 'Always retry on 500', body: 'blindly retry',
      sourceKind: 'human', validationState: 'contradicted',
    })

    const r = await runProposerSweep(db, { propose: proposeKnowledgeDiff, projectId: p.id })
    expect(r.proposals).toBe(1)

    const [row] = await db.select().from(knowledgeProposals).where(and(
      eq(knowledgeProposals.projectId, p.id),
      eq(knowledgeProposals.target, 'knowledge'),
    ))
    expect(row!.status).toBe('pending')
    expect((row!.change as { kind?: string }).kind).toBe('pitfall')
    expect(row!.triggerSignature).toMatch(/^contradicted:/)
  })
})
