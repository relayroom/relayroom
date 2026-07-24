/**
 * Reflection proposer (FEAT-0005 L4).
 *
 * The invariants under test: clustering fires only at the threshold (>=2 distinct
 * agents OR >=3 occurrences), a null-signature error never pools into a pattern, the
 * draft is a candidate pitfall (never a promotion), the sweep is a single writer per
 * project under a real held lock, and re-running is idempotent (a signature already
 * queued is not re-created). The proposeKnowledgeDiff call is injected here, exactly
 * as it will be wired to @relayroom/db once core lands.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { agents, events, projects } from '@relayroom/db'
import postgres from 'postgres'
import {
  clusterErrors,
  PROPOSER_MIN_AGENTS,
  PROPOSER_MIN_COUNT,
  runProposerSweep,
  type ProposalDraft,
  type ProposeFn,
} from '../src/knowledge/proposer'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

async function project(): Promise<{ id: string }> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `pr-org-${sfx}`, slug: `pr-${sfx}`, name: 'Proposer', connectCode: `pr-cc-${sfx}`,
  }).returning({ id: projects.id })
  return { id: p!.id }
}

async function agent(projectId: string): Promise<string> {
  const [a] = await db.insert(agents).values({ projectId, part: `p${randomBytes(3).toString('hex')}` })
    .returning({ id: agents.id })
  return a!.id
}

async function errorEvent(projectId: string, agentId: string | null, detail: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({ projectId, agentId, type: 'error', detail })
}

/** A fake ProposeFn recording calls, simulating core's open-signature idempotency
 *  (a (project, triggerSignature) already queued returns null). */
function makePropose() {
  const calls: Array<{ projectId: string } & ProposalDraft> = []
  const seen = new Set<string>()
  const propose: ProposeFn = async (_tx, input) => {
    calls.push(input)
    const key = `${input.projectId}|${input.triggerSignature ?? ''}`
    if (seen.has(key)) return null
    seen.add(key)
    return { id: `prop-${seen.size}` }
  }
  return { propose, calls }
}

describe('clusterErrors (pure)', () => {
  const row = (agentId: string | null, detail: Record<string, unknown>, i = 0) =>
    ({ detail, agentId, eventId: `e${agentId}-${i}` })

  it('fires when a signature spans >= 2 distinct agents (even once each)', () => {
    const clusters = clusterErrors([
      row('a1', { code: 'E_DB', area: 'db' }),
      row('a2', { code: 'E_DB', area: 'db' }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.agents).toBe(PROPOSER_MIN_AGENTS)
    expect(clusters[0]!.count).toBe(2)
  })

  it('fires when a signature recurs >= 3 times for a single agent', () => {
    const clusters = clusterErrors([
      row('a1', { code: 'E_X' }, 0),
      row('a1', { code: 'E_X' }, 1),
      row('a1', { code: 'E_X' }, 2),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.count).toBe(PROPOSER_MIN_COUNT)
    expect(clusters[0]!.agents).toBe(1)
  })

  it('does NOT fire below both thresholds (1 agent, 2 times)', () => {
    const clusters = clusterErrors([
      row('a1', { code: 'E_Y' }, 0),
      row('a1', { code: 'E_Y' }, 1),
    ])
    expect(clusters).toHaveLength(0)
  })

  it('drops null-signature errors so "no detail" is not its own pattern', () => {
    const clusters = clusterErrors([
      row('a1', {}), row('a2', {}), row('a3', {}), // no code/area -> null signature
    ])
    expect(clusters).toHaveLength(0)
  })

  it('separates distinct signatures', () => {
    const clusters = clusterErrors([
      row('a1', { code: 'E_A' }, 0), row('a1', { code: 'E_A' }, 1), row('a1', { code: 'E_A' }, 2),
      row('a1', { code: 'E_B' }, 0), row('a1', { code: 'E_B' }, 1), row('a1', { code: 'E_B' }, 2),
    ])
    expect(clusters).toHaveLength(2)
    expect(new Set(clusters.map(c => c.signature)).size).toBe(2)
  })
})

describe('runProposerSweep', () => {
  it('drafts a candidate pitfall from a signature seen across 2 agents', async () => {
    const p = await project()
    const a1 = await agent(p.id)
    const a2 = await agent(p.id)
    await errorEvent(p.id, a1, { code: 'E_TIMEOUT', area: 'wake' })
    await errorEvent(p.id, a2, { code: 'E_TIMEOUT', area: 'wake' })

    const { propose, calls } = makePropose()
    const r = await runProposerSweep(db, { propose, projectId: p.id })
    expect(r.proposals).toBe(1)
    expect(calls).toHaveLength(1)
    const draft = calls[0]!
    // Load-bearing invariant: proposer output is a candidate pitfall, never a promotion.
    expect(draft.target).toBe('knowledge')
    expect(draft.change.kind).toBe('pitfall')
    expect(draft.evidence.agents).toBe(2)
    expect(draft.evidence.count).toBe(2)
    expect(draft.evidence.signature).toMatch(/^[0-9a-f]{64}$/)
    // triggerSignature is the dedup key core's open-signature index enforces.
    expect(draft.triggerSignature).toBe(draft.evidence.signature)
  })

  it('does not propose below threshold', async () => {
    const p = await project()
    const a1 = await agent(p.id)
    await errorEvent(p.id, a1, { code: 'E_ONCE' })
    await errorEvent(p.id, a1, { code: 'E_ONCE' }) // 1 agent, 2 times

    const { propose, calls } = makePropose()
    const r = await runProposerSweep(db, { propose, projectId: p.id })
    expect(r.proposals).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('is idempotent: a re-run does not re-create an already-queued signature', async () => {
    const p = await project()
    const a1 = await agent(p.id)
    for (let i = 0; i < 3; i++) await errorEvent(p.id, a1, { code: 'E_REPEAT' })

    const { propose, calls } = makePropose()
    const r1 = await runProposerSweep(db, { propose, projectId: p.id })
    const r2 = await runProposerSweep(db, { propose, projectId: p.id })
    expect(r1.proposals).toBe(1)
    expect(r2.proposals).toBe(0) // core's open-signature index dedups; sweep counts only new
    expect(calls).toHaveLength(2) // still CALLED both times (idempotency is core's, not a skip)
  })

  it('auto-discovers projects with recent errors when not pinned', async () => {
    const p = await project()
    const a1 = await agent(p.id)
    const a2 = await agent(p.id)
    await errorEvent(p.id, a1, { code: 'E_DISCOVER', file: 'x.ts' })
    await errorEvent(p.id, a2, { code: 'E_DISCOVER', file: 'x.ts' })

    const { propose, calls } = makePropose()
    await runProposerSweep(db, { propose }) // no projectId
    // At least our project's signature was proposed (other projects may coexist in the db).
    expect(calls.some(c => c.projectId === p.id && c.change.kind === 'pitfall')).toBe(true)
  })

  it('respects the lookback window - stale errors do not cluster', async () => {
    const p = await project()
    const a1 = await agent(p.id)
    const a2 = await agent(p.id)
    await errorEvent(p.id, a1, { code: 'E_OLD' })
    await errorEvent(p.id, a2, { code: 'E_OLD' })
    // Backdate both events beyond the window.
    await rawSql`update event set created_at = now() - interval '30 days' where project_id = ${p.id}`

    const { propose } = makePropose()
    const r = await runProposerSweep(db, { propose, projectId: p.id, windowDays: 7 })
    expect(r.proposals).toBe(0)
  })

  it('single writer: a held advisory lock blocks the sweep (not a lucky serialization)', async () => {
    const p = await project()
    const a1 = await agent(p.id)
    const a2 = await agent(p.id)
    await errorEvent(p.id, a1, { code: 'E_LOCK', area: 'x' })
    await errorEvent(p.id, a2, { code: 'E_LOCK', area: 'x' })

    // Hold the proposer's lock (namespace 'PROP' = 0x50524f50) for this project.
    const holder = postgres(TEST_DATABASE_URL, { max: 1 })
    const conn = await holder.reserve()
    const { propose, calls } = makePropose()
    try {
      await conn`begin`
      await conn`select pg_advisory_xact_lock(${0x50524f50}, hashtext(${p.id}))`

      const r = await runProposerSweep(db, { propose, projectId: p.id })
      expect(r.projects).toBe(0) // could not claim; skipped
      expect(calls).toHaveLength(0)

      await conn`rollback`
    }
    finally {
      conn.release()
      await holder.end({ timeout: 5 })
    }

    // With the lock released, the next sweep processes it.
    const r2 = await runProposerSweep(db, { propose, projectId: p.id })
    expect(r2.proposals).toBe(1)
  })
})
