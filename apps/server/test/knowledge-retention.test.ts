/**
 * Expiry sweep for knowledge (FEAT-0001 L0).
 *
 * The sweep is bookkeeping, not enforcement: `recall` filters `expires_at` itself,
 * so an expired entry stops being readable at its expiry whether or not the sweep
 * has run. Both halves are asserted here, because a sweep that were the enforcement
 * path would leave expired entries readable for as long as the timer was late, and
 * nothing about the code's shape tells you which of the two it is.
 *
 * Candidate GC is deliberately absent from L0 - it needs a retention policy that
 * arrives in L3 - so there is a test pinning that candidates without an expiry are
 * left alone. Otherwise "it does not collect candidates" looks like an oversight to
 * the next reader instead of a decision.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { knowledge, knowledgeAudits, projects } from '@relayroom/db'
import postgres from 'postgres'
import { runKnowledgeRetention, RETENTION_PER_PROJECT_FLOOR } from '../src/knowledge/retention'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const past = (ms = 60_000) => new Date(Date.now() - ms)
const future = (ms = 60 * 60_000) => new Date(Date.now() + ms)

async function project(): Promise<string> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `kr-org-${sfx}`, slug: `kr-${sfx}`, name: 'Retention', connectCode: `kr-cc-${sfx}`,
  }).returning({ id: projects.id })
  return p!.id
}

async function entry(projectId: string, opts: {
  state?: string
  expiresAt?: Date | null
  title?: string
} = {}): Promise<string> {
  const [row] = await db.insert(knowledge).values({
    projectId,
    kind: 'fact',
    title: opts.title ?? `entry-${randomBytes(3).toString('hex')}`,
    body: 'body',
    sourceKind: 'human',
    validationState: opts.state ?? 'trusted',
    expiresAt: opts.expiresAt ?? null,
  }).returning({ id: knowledge.id })
  return row!.id
}

async function stateOf(id: string): Promise<string> {
  const [row] = await db.select({ s: knowledge.validationState }).from(knowledge).where(eq(knowledge.id, id))
  return row!.s
}

describe('expiry sweep', () => {
  it('retires an entry whose expiry has passed', async () => {
    const p = await project()
    const expired = await entry(p, { expiresAt: past() })

    const r = await runKnowledgeRetention(db, { projectId: p })
    expect(r.retired).toBe(1)
    expect(await stateOf(expired)).toBe('retired')
  })

  it('leaves an entry whose expiry is still ahead', async () => {
    const p = await project()
    const live = await entry(p, { expiresAt: future() })

    await runKnowledgeRetention(db, { projectId: p })
    expect(await stateOf(live)).toBe('trusted')
  })

  it('leaves entries with no expiry alone, including candidates', async () => {
    // Candidate GC is L3: it needs knowledgeConfig.retentionDays, which L0 has no
    // value for. This is a decision, not a gap.
    const p = await project()
    const trusted = await entry(p, { expiresAt: null })
    const candidate = await entry(p, { state: 'candidate', expiresAt: null })

    const r = await runKnowledgeRetention(db, { projectId: p })
    expect(r.retired).toBe(0)
    expect(await stateOf(trusted)).toBe('trusted')
    expect(await stateOf(candidate)).toBe('candidate')
  })

  it('retires an expired candidate too', async () => {
    // An explicit expiry means somebody set a date on this entry; that applies
    // whether or not it was ever promoted.
    const p = await project()
    const id = await entry(p, { state: 'candidate', expiresAt: past() })

    await runKnowledgeRetention(db, { projectId: p })
    expect(await stateOf(id)).toBe('retired')
  })

  it('does not touch terminal states', async () => {
    // Moving these would write audit rows recording nothing.
    const p = await project()
    const retired = await entry(p, { state: 'retired', expiresAt: past() })
    const contradicted = await entry(p, { state: 'contradicted', expiresAt: past() })

    const r = await runKnowledgeRetention(db, { projectId: p })
    expect(r.retired).toBe(0)
    expect(await stateOf(retired)).toBe('retired')
    expect(await stateOf(contradicted)).toBe('contradicted')
  })

  it('writes an audit row naming what changed and why', async () => {
    const p = await project()
    const id = await entry(p, { expiresAt: past() })
    await runKnowledgeRetention(db, { projectId: p })

    const [audit] = await db.select().from(knowledgeAudits)
      .where(and(eq(knowledgeAudits.knowledgeId, id), eq(knowledgeAudits.action, 'retire')))
    expect(audit).toBeDefined()
    expect(audit!.fromState).toBe('trusted')
    expect(audit!.toState).toBe('retired')
    // 'system', because no person typed this - the entry's own expiry did it.
    expect(audit!.actorKind).toBe('system')
    expect(audit!.actorUserId).toBeNull()
    expect(audit!.detail).toMatchObject({ reason: 'expired' })
  })

  it('is idempotent - a second pass retires nothing and adds no audit rows', async () => {
    const p = await project()
    const id = await entry(p, { expiresAt: past() })

    expect((await runKnowledgeRetention(db, { projectId: p })).retired).toBe(1)
    expect((await runKnowledgeRetention(db, { projectId: p })).retired).toBe(0)

    const audits = await db.select().from(knowledgeAudits)
      .where(eq(knowledgeAudits.knowledgeId, id))
    expect(audits).toHaveLength(1)
  })

  it('does not let one project take the whole batch', async () => {
    // BUG-0008 again: the batch is instance-wide, so a project with a large expiry
    // backlog would otherwise starve another project's expired entries entirely.
    const hog = await project()
    const other = await project()
    const limit = RETENTION_PER_PROJECT_FLOOR + 2

    for (let i = 0; i < limit * 2; i++) await entry(hog, { expiresAt: past(60_000 + i) })
    const otherIds: string[] = []
    for (let i = 0; i < 2; i++) otherIds.push(await entry(other, { expiresAt: past(1_000) }))

    // A batch smaller than the hog's backlog: without a per-project ceiling the
    // hog's older entries sort first and fill it.
    await runKnowledgeRetention(db, { limit })

    for (const id of otherIds) expect(await stateOf(id)).toBe('retired')
  })
})
