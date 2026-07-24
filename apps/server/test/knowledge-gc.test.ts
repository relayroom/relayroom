/**
 * Retention-policy garbage collection (FEAT-0004 L3): candidates aging out with no
 * support are retired; retired entries past retentionDays*2 are hard-deleted; only
 * projects that set retentionDays are touched.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { knowledge, knowledgeValidations, projects } from '@relayroom/db'
import { runKnowledgeGarbageCollection } from '../src/knowledge/retention'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'
import postgres from 'postgres'

const { db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const NOW = new Date('2026-07-24T00:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

async function project(retentionDays?: number): Promise<string> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `gc-org-${sfx}`, slug: `gc-${sfx}`, name: 'GC', connectCode: `gc-cc-${sfx}`,
    ...(retentionDays !== undefined ? { knowledgeConfig: { retentionDays } } : {}),
  }).returning({ id: projects.id })
  return p!.id
}

async function entry(projectId: string, opts: {
  state?: string; createdAt?: Date; updatedAt?: Date
}): Promise<string> {
  const [k] = await db.insert(knowledge).values({
    projectId, kind: 'fact', title: `g-${randomBytes(3).toString('hex')}`, body: 'b',
    sourceKind: 'proposer', validationState: opts.state ?? 'candidate',
    createdAt: opts.createdAt, updatedAt: opts.updatedAt ?? opts.createdAt,
  }).returning({ id: knowledge.id })
  return k!.id
}

async function support(knowledgeId: string) {
  await db.insert(knowledgeValidations).values({
    knowledgeId, signal: 'support', issuer: 'human', issuerId: 'u',
    sourceFingerprint: randomBytes(6).toString('hex'),
  })
}

async function stateOf(id: string): Promise<string | null> {
  const [row] = await db.select({ s: knowledge.validationState }).from(knowledge).where(eq(knowledge.id, id))
  return row?.s ?? null
}

describe('candidate retire', () => {
  it('retires an unsupported candidate older than retentionDays', async () => {
    const p = await project(30)
    const old = await entry(p, { state: 'candidate', createdAt: daysAgo(40) })
    const r = await runKnowledgeGarbageCollection(db, { projectId: p, now: NOW })
    expect(r.retired).toBe(1)
    expect(await stateOf(old)).toBe('retired')
  })

  it('spares a candidate younger than retentionDays', async () => {
    const p = await project(30)
    const fresh = await entry(p, { state: 'candidate', createdAt: daysAgo(10) })
    await runKnowledgeGarbageCollection(db, { projectId: p, now: NOW })
    expect(await stateOf(fresh)).toBe('candidate')
  })

  it('spares an old candidate that has a supporting validation', async () => {
    // Something backed it - it is a live claim awaiting a second issuer, not abandoned.
    const p = await project(30)
    const backed = await entry(p, { state: 'candidate', createdAt: daysAgo(40) })
    await support(backed)
    const r = await runKnowledgeGarbageCollection(db, { projectId: p, now: NOW })
    expect(r.retired).toBe(0)
    expect(await stateOf(backed)).toBe('candidate')
  })
})

describe('retired hard-delete', () => {
  it('hard-deletes a retired entry past retentionDays * 2', async () => {
    const p = await project(30)
    // retired 70 days ago > 60 (=30*2)
    const gone = await entry(p, { state: 'retired', createdAt: daysAgo(100), updatedAt: daysAgo(70) })
    const r = await runKnowledgeGarbageCollection(db, { projectId: p, now: NOW })
    expect(r.deleted).toBe(1)
    expect(await stateOf(gone)).toBeNull() // row removed
  })

  it('keeps a retired entry still within retentionDays * 2', async () => {
    const p = await project(30)
    const kept = await entry(p, { state: 'retired', createdAt: daysAgo(60), updatedAt: daysAgo(40) })
    const r = await runKnowledgeGarbageCollection(db, { projectId: p, now: NOW })
    expect(r.deleted).toBe(0)
    expect(await stateOf(kept)).toBe('retired')
  })
})

describe('policy gating', () => {
  it('does nothing for a project with no retentionDays configured', async () => {
    const p = await project() // no policy
    const old = await entry(p, { state: 'candidate', createdAt: daysAgo(400) })
    const r = await runKnowledgeGarbageCollection(db, { projectId: p, now: NOW })
    expect(r).toEqual({ retired: 0, deleted: 0 })
    expect(await stateOf(old)).toBe('candidate')
  })
})
