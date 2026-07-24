import { randomBytes, createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import {
  decideProposal,
  proposeKnowledgeDiff,
  rollbackPlaybook,
} from '../src/knowledge'
import { knowledge, knowledgeAudits, knowledgeProposals, playbookVersions, projects } from '../src/schema'
import { better_auth_user } from '../src/auth-schema'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

// The decision audit FKs actor_user_id to a real better_auth_user, so the human
// deciding a proposal has to exist.
const USER = `usr-proposer-${randomBytes(4).toString('hex')}`
beforeAll(async () => {
  await db.insert(better_auth_user)
    .values({ id: USER, name: 'Proposer Tester', email: `${USER}@test.local` })
    .onConflictDoNothing()
})

async function project(): Promise<string> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `pr-org-${sfx}`, slug: `pr-${sfx}`, name: 'Proposer', connectCode: `pr-cc-${sfx}`,
  }).returning({ id: projects.id })
  return p!.id
}

const knowledgeProposal = (projectId: string, over: Partial<Parameters<typeof proposeKnowledgeDiff>[1]> = {}) =>
  proposeKnowledgeDiff(db, {
    projectId,
    target: 'knowledge',
    hypothesis: 'agents keep forgetting to run migrations',
    disconfirming: 'the error stops appearing without any playbook change',
    change: { title: 'run migrations on boot', body: 'the server applies pending migrations at startup', kind: 'pitfall' },
    triggerSignature: 'sig-migrate',
    evidence: { signature: 'sig-migrate', count: 3, agents: 2 },
    ...over,
  })

describe('proposeKnowledgeDiff', () => {
  it('queues a pending proposal', async () => {
    const p = await project()
    const row = await knowledgeProposal(p)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('pending')
    expect(row!.target).toBe('knowledge')
    expect(row!.createdByJob).toBe('proposer')
  })

  it('does not double-queue the same open signature', async () => {
    // The partial unique index: one OPEN proposal per (project, signature). The
    // proposer re-firing on the same recurring error must be a silent no-op.
    const p = await project()
    const first = await knowledgeProposal(p)
    const again = await knowledgeProposal(p)
    expect(first).not.toBeNull()
    expect(again).toBeNull()
    const rows = await db.select().from(knowledgeProposals)
      .where(eq(knowledgeProposals.projectId, p))
    expect(rows).toHaveLength(1)
  })

  it('allows a re-propose once the prior one is decided', async () => {
    // A rejected/approved proposal must not block the signature forever - only a
    // PENDING one does. That is the whole point of the partial index.
    const p = await project()
    const first = await knowledgeProposal(p)
    await decideProposal(db, { projectId: p, proposalId: first!.id, decision: 'rejected', userId: USER })
    const second = await knowledgeProposal(p)
    expect(second).not.toBeNull()
    expect(second!.id).not.toBe(first!.id)
  })
})

describe('decideProposal', () => {
  it('approves a knowledge proposal as a CANDIDATE, never trusted', async () => {
    // The trust boundary. A human approving the proposal is intake, not promotion:
    // the fact still has to earn trusted through K independent issuers.
    const p = await project()
    const proposal = await knowledgeProposal(p)
    const result = await decideProposal(db, { projectId: p, proposalId: proposal!.id, decision: 'approved', userId: USER })
    expect(result).toMatchObject({ ok: true, status: 'approved', target: 'knowledge' })
    if (!result.ok) throw new Error('unreachable')

    const [k] = await db.select().from(knowledge).where(eq(knowledge.id, result.knowledgeId!))
    expect(k!.validationState).toBe('candidate') // NOT trusted
    expect(k!.sourceKind).toBe('proposer')
    expect(k!.promotedAt).toBeNull()

    const [audit] = await db.select().from(knowledgeAudits).where(eq(knowledgeAudits.id, result.auditId))
    expect(audit).toMatchObject({ action: 'proposer_approve', actorKind: 'human', actorUserId: USER })
    // the proposal points back at its decision audit
    const [decided] = await db.select().from(knowledgeProposals).where(eq(knowledgeProposals.id, proposal!.id))
    expect(decided!.auditId).toBe(result.auditId)
    expect(decided!.status).toBe('approved')
  })

  it('records a rejection with an audit and writes no knowledge', async () => {
    const p = await project()
    const proposal = await knowledgeProposal(p)
    const result = await decideProposal(db, { projectId: p, proposalId: proposal!.id, decision: 'rejected', userId: USER })
    expect(result).toMatchObject({ ok: true, status: 'rejected' })
    if (!result.ok) throw new Error('unreachable')
    expect(await db.select().from(knowledge).where(eq(knowledge.projectId, p))).toHaveLength(0)
    const [audit] = await db.select().from(knowledgeAudits).where(eq(knowledgeAudits.id, result.auditId))
    expect(audit!.action).toBe('proposer_reject')
  })

  it('is a no-op on a proposal that is already decided', async () => {
    // Re-decide (double-click, retry) must not write a second audit or a second
    // knowledge row.
    const p = await project()
    const proposal = await knowledgeProposal(p)
    await decideProposal(db, { projectId: p, proposalId: proposal!.id, decision: 'approved', userId: USER })
    const again = await decideProposal(db, { projectId: p, proposalId: proposal!.id, decision: 'rejected', userId: USER })
    expect(again).toEqual({ ok: false, reason: 'not_pending', status: 'approved' })
    expect(await db.select().from(knowledge).where(eq(knowledge.projectId, p))).toHaveLength(1)
    expect(await db.select().from(knowledgeAudits).where(eq(knowledgeAudits.projectId, p))).toHaveLength(1)
  })

  it('will not decide another project\'s proposal', async () => {
    const owner = await project()
    const attacker = await project()
    const proposal = await knowledgeProposal(owner)
    const result = await decideProposal(db, { projectId: attacker, proposalId: proposal!.id, decision: 'approved', userId: USER })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    const [still] = await db.select().from(knowledgeProposals).where(eq(knowledgeProposals.id, proposal!.id))
    expect(still!.status).toBe('pending')
  })

  it('approves a playbook proposal into a new version and updates the live copy', async () => {
    const p = await project()
    const body = '# RELAYROOM.md\n\nAlways rebase before starting.\n'
    const proposal = await proposeKnowledgeDiff(db, {
      projectId: p, target: 'playbook',
      hypothesis: 'a rebase norm would cut base mistakes',
      change: { content: body, patch: '+ Always rebase before starting.' },
      triggerSignature: 'sig-playbook',
    })
    const result = await decideProposal(db, { projectId: p, proposalId: proposal!.id, decision: 'approved', userId: USER })
    expect(result).toMatchObject({ ok: true, status: 'approved', target: 'playbook', version: 1 })

    const [v] = await db.select().from(playbookVersions)
      .where(and(eq(playbookVersions.projectId, p), eq(playbookVersions.version, 1)))
    expect(v!.content).toBe(body)
    expect(v!.contentHash).toBe(createHash('sha256').update(body).digest('hex'))
    expect(v!.proposalId).toBe(proposal!.id)
    const [proj] = await db.select().from(projects).where(eq(projects.id, p))
    expect(proj!.relayroomMd).toBe(body) // the live served copy now points at it
  })

  it('rejects a playbook proposal whose change carries no full body', async () => {
    // The db layer applies no diffs - a bare patch is not something it can snapshot.
    const p = await project()
    const proposal = await proposeKnowledgeDiff(db, {
      projectId: p, target: 'playbook', hypothesis: 'h',
      change: { patch: '+ some line' }, triggerSignature: 'sig-nopatch',
    })
    await expect(decideProposal(db, { projectId: p, proposalId: proposal!.id, decision: 'approved', userId: USER }))
      .rejects.toThrow(/full authored body/)
    // and the failed transaction left the proposal pending
    const [still] = await db.select().from(knowledgeProposals).where(eq(knowledgeProposals.id, proposal!.id))
    expect(still!.status).toBe('pending')
  })
})

describe('rollbackPlaybook', () => {
  const approvePlaybook = async (projectId: string, content: string, sig: string) => {
    const proposal = await proposeKnowledgeDiff(db, {
      projectId, target: 'playbook', hypothesis: 'h', change: { content }, triggerSignature: sig,
    })
    return decideProposal(db, { projectId, proposalId: proposal!.id, decision: 'approved', userId: USER })
  }

  it('appends a new version equal to a prior one and never mutates history', async () => {
    const p = await project()
    await approvePlaybook(p, 'v1 body', 'sig-r1') // version 1
    await approvePlaybook(p, 'v2 body', 'sig-r2') // version 2

    const result = await rollbackPlaybook(db, { projectId: p, toVersion: 1, userId: USER })
    expect(result).toMatchObject({ ok: true, version: 3, rolledBackTo: 1 })

    const versions = await db.select().from(playbookVersions)
      .where(eq(playbookVersions.projectId, p))
    expect(versions).toHaveLength(3)               // appended, not overwritten
    const v3 = versions.find(v => v.version === 3)!
    expect(v3.content).toBe('v1 body')             // content equals the rolled-back-to version
    expect(versions.find(v => v.version === 1)!.content).toBe('v1 body') // v1 untouched
    expect(versions.find(v => v.version === 2)!.content).toBe('v2 body') // v2 untouched

    const [proj] = await db.select().from(projects).where(eq(projects.id, p))
    expect(proj!.relayroomMd).toBe('v1 body')      // live copy follows the rollback

    if (!result.ok) throw new Error('unreachable')
    const [audit] = await db.select().from(knowledgeAudits).where(eq(knowledgeAudits.id, result.auditId))
    expect(audit!.action).toBe('playbook_change')
    expect(audit!.detail).toMatchObject({ rolledBackTo: 1, newVersion: 3 })
  })

  it('refuses to roll back to a version that does not exist', async () => {
    const p = await project()
    await approvePlaybook(p, 'only body', 'sig-solo')
    const result = await rollbackPlaybook(db, { projectId: p, toVersion: 9, userId: USER })
    expect(result).toEqual({ ok: false, reason: 'version_not_found' })
  })
})
