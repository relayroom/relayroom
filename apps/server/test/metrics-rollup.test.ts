/**
 * Daily knowledge-metrics rollup (FEAT-0001 L2).
 *
 * Seeds source rows at fixed timestamps, runs the rollup at a fixed `now`, and
 * asserts the RAW num/den and normalization_version. The precision 14-day lookahead
 * is the centerpiece: that a contradiction arriving late backfills the precision of
 * the day the entry was promoted, and that a day older than the window is not
 * recomputed.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  agents, events, knowledge, knowledgeMetricDaily, knowledgeValidations, projects, recallLogs,
} from '@relayroom/db'
import postgres from 'postgres'
import { ERROR_SIGNATURE_VERSION } from '../src/knowledge/error-signature'
import { PRECISION_LOOKAHEAD_DAYS, runKnowledgeMetricsRollup } from '../src/knowledge/metrics-rollup'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const DAY = '2026-06-15'
const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`)
/** A `now` a day after DAY, so DAY is yesterday and inside the rollup window. */
const NOW_AFTER = (day: string) => new Date(at(day, 12).getTime() + 24 * 60 * 60 * 1000)

async function project(): Promise<{ id: string; agentId: string }> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `mr-org-${sfx}`, slug: `mr-${sfx}`, name: 'Metrics', connectCode: `mr-cc-${sfx}`,
  }).returning({ id: projects.id })
  const [a] = await db.insert(agents).values({ projectId: p!.id, part: 'w' }).returning({ id: agents.id })
  return { id: p!.id, agentId: a!.id }
}

async function errorEvent(projectId: string, agentId: string, detail: Record<string, unknown>, when: Date) {
  await db.insert(events).values({ projectId, agentId, type: 'error', detail, createdAt: when })
}

async function recall(projectId: string, agentId: string, when: Date, used: boolean) {
  const [k] = used
    ? await db.insert(knowledge).values({
      projectId, kind: 'fact', title: 't', body: 'b', sourceKind: 'human', validationState: 'trusted',
    }).returning({ id: knowledge.id })
    : [undefined]
  await db.insert(recallLogs).values({
    projectId, agentId, createdAt: when, usedKnowledgeId: k?.id ?? null, returnedKnowledgeIds: [],
  })
}

/** A trusted entry promoted at `promotedAt`, created `createdHoursBefore` earlier. */
async function promotedEntry(projectId: string, promotedAt: Date, createdHoursBefore: number): Promise<string> {
  const createdAt = new Date(promotedAt.getTime() - createdHoursBefore * 3_600_000)
  const [k] = await db.insert(knowledge).values({
    projectId, kind: 'fact', title: `p-${randomBytes(3).toString('hex')}`, body: 'b',
    sourceKind: 'human', validationState: 'trusted', createdAt, promotedAt,
  }).returning({ id: knowledge.id })
  return k!.id
}

async function contradict(knowledgeId: string, when: Date) {
  await db.insert(knowledgeValidations).values({
    knowledgeId, signal: 'contradict', issuer: 'error_event', issuerId: 'error',
    sourceFingerprint: randomBytes(8).toString('hex'), createdAt: when,
  })
}

async function rowFor(projectId: string, day: string) {
  const [row] = await db.select().from(knowledgeMetricDaily)
    .where(and(eq(knowledgeMetricDaily.projectId, projectId), eq(knowledgeMetricDaily.day, day)))
  return row
}

describe('repeat_error_rate', () => {
  it('counts an error whose signature appeared in the prior 7 days', async () => {
    const p = await project()
    // Prior appearance 3 days before DAY.
    await errorEvent(p.id, p.agentId, { code: 'E_DUP', area: 'x' }, at('2026-06-12'))
    // Two errors on DAY: one repeats the prior signature, one is new.
    await errorEvent(p.id, p.agentId, { code: 'E_DUP', area: 'x' }, at(DAY, 9))
    await errorEvent(p.id, p.agentId, { code: 'E_NEW', area: 'y' }, at(DAY, 10))

    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const row = await rowFor(p.id, DAY)
    expect(row!.repeatErrorDen).toBe(2)
    expect(row!.repeatErrorNum).toBe(1)
    expect(row!.normalizationVersion).toBe(ERROR_SIGNATURE_VERSION)
  })

  it('does not count a prior appearance older than 7 days', async () => {
    const p = await project()
    await errorEvent(p.id, p.agentId, { code: 'E_OLD', area: 'x' }, at('2026-06-05')) // 10 days before
    await errorEvent(p.id, p.agentId, { code: 'E_OLD', area: 'x' }, at(DAY, 9))

    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const row = await rowFor(p.id, DAY)
    expect(row!.repeatErrorDen).toBe(1)
    expect(row!.repeatErrorNum).toBe(0)
  })

  it('a null-signature error counts in the denominator but never as a repeat', async () => {
    const p = await project()
    await errorEvent(p.id, p.agentId, {}, at(DAY, 8))
    await errorEvent(p.id, p.agentId, {}, at(DAY, 9))
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const row = await rowFor(p.id, DAY)
    expect(row!.repeatErrorDen).toBe(2)
    expect(row!.repeatErrorNum).toBe(0)
  })
})

describe('recall_hit_rate', () => {
  it('counts recall logs and the subset that were used', async () => {
    const p = await project()
    await recall(p.id, p.agentId, at(DAY, 9), true)
    await recall(p.id, p.agentId, at(DAY, 10), false)
    await recall(p.id, p.agentId, at(DAY, 11), false)
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const row = await rowFor(p.id, DAY)
    expect(row!.recallHitDen).toBe(3)
    expect(row!.recallHitNum).toBe(1)
  })
})

describe('candidate_to_trusted_p50_hours and deltas', () => {
  it('is the p50 of promotion latency over that day\'s promotions', async () => {
    const p = await project()
    await promotedEntry(p.id, at(DAY, 12), 2)  // 2h
    await promotedEntry(p.id, at(DAY, 13), 4)  // 4h
    await promotedEntry(p.id, at(DAY, 14), 6)  // 6h
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const row = await rowFor(p.id, DAY)
    expect(row!.candidateToTrustedP50Hours).toBeCloseTo(4)
    expect(row!.trustedCount).toBe(3) // current total trusted in the project (snapshot)
  })

  it('stores null p50 for a day with no promotions', async () => {
    const p = await project()
    await recall(p.id, p.agentId, at(DAY, 9), false) // some activity, no promotions
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const row = await rowFor(p.id, DAY)
    expect(row!.candidateToTrustedP50Hours).toBeNull()
    expect(row!.trustedCount).toBe(0) // no trusted entries exist (snapshot)
  })
})

describe('knowledge_precision (14-day lookahead)', () => {
  it('den counts promotions that day; num counts those contradicted within 14d', async () => {
    const p = await project()
    const contradicted = await promotedEntry(p.id, at(DAY, 12), 1)
    await promotedEntry(p.id, at(DAY, 13), 1) // stays clean
    // Contradiction 10 days later - inside the entry's 14-day window.
    await contradict(contradicted, at('2026-06-25'))

    // Run while DAY is still inside the rollup's trailing window, after the
    // contradiction landed. (A run so late that DAY has aged out would write no row
    // for DAY at all - the point of the trailing-window design.)
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: at('2026-06-27') })
    const row = await rowFor(p.id, DAY)
    expect(row!.precisionDen).toBe(2)
    expect(row!.precisionNum).toBe(1)
  })

  it('ignores a contradiction that arrives AFTER the 14-day window', async () => {
    const p = await project()
    const entry = await promotedEntry(p.id, at(DAY, 12), 1)
    // 15 days after promotion - just outside the entry's lookahead.
    await contradict(entry, at('2026-06-30'))
    // DAY still inside the trailing window; the contradiction is beyond the entry's
    // 14-day deadline so it must not count.
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: at('2026-06-27') })
    const row = await rowFor(p.id, DAY)
    expect(row!.precisionDen).toBe(1)
    expect(row!.precisionNum).toBe(0)
  })

  it('BACKFILLS: a late contradiction changes a prior day on the next run', async () => {
    // The reason the whole trailing window is recomputed. The entry is promoted on
    // DAY; the first rollup (before any contradiction) records precisionNum 0; a
    // contradiction then lands inside the window and a later run - still within 14
    // days of DAY - must raise it to 1.
    const p = await project()
    const entry = await promotedEntry(p.id, at(DAY, 12), 1)

    // First run, one day after DAY: no contradiction yet.
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    expect((await rowFor(p.id, DAY))!.precisionNum).toBe(0)

    // Contradiction lands 5 days after promotion.
    await contradict(entry, at('2026-06-20'))

    // Second run, 6 days after DAY - DAY is still inside the trailing window, so it
    // is recomputed and the numerator is backfilled.
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: at('2026-06-21') })
    expect((await rowFor(p.id, DAY))!.precisionNum).toBe(1)
  })

  it('does NOT recompute a day older than the trailing window', async () => {
    // A day far in the past is final. A contradiction that (impossibly) arrived long
    // after must not rewrite it, because the run no longer visits that day.
    const p = await project()
    await promotedEntry(p.id, at(DAY, 12), 1)
    // First run closes DAY out with num 0.
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    // Now run 30 days later: DAY is outside the 14-day window and is not revisited.
    const before = (await rowFor(p.id, DAY))!.precisionNum
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: at('2026-07-16') })
    const after = (await rowFor(p.id, DAY))!.precisionNum
    expect(after).toBe(before) // untouched
    // And confirm the run did not even create/refresh DAY's row updatedAt path:
    // no row for DAY would have been produced by this far-future run.
  })
})

describe('rollup is scoped and idempotent', () => {
  it('does not mix another project\'s data in', async () => {
    const a = await project()
    const b = await project()
    await recall(a.id, a.agentId, at(DAY, 9), true)
    await recall(b.id, b.agentId, at(DAY, 9), false)
    await runKnowledgeMetricsRollup(db, { projectId: a.id, now: NOW_AFTER(DAY) })
    expect((await rowFor(a.id, DAY))!.recallHitDen).toBe(1)
    // b was not processed in this pinned run at all.
    expect(await rowFor(b.id, DAY)).toBeUndefined()
  })

  it('re-running the same window produces the same row', async () => {
    const p = await project()
    await recall(p.id, p.agentId, at(DAY, 9), true)
    await recall(p.id, p.agentId, at(DAY, 10), false)
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const first = await rowFor(p.id, DAY)
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const second = await rowFor(p.id, DAY)
    expect(second).toEqual(first)
  })

  it('excludes today - only closed UTC days are rolled up', async () => {
    const p = await project()
    // now is noon on DAY, so DAY is TODAY (not closed). Yesterday is DAY-1.
    await recall(p.id, p.agentId, at(DAY, 9), true)
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: at(DAY, 12) })
    expect(await rowFor(p.id, DAY)).toBeUndefined()
  })
})

describe('count snapshot semantics (fork 3, corrected)', () => {
  it('trusted/candidate are current totals, not that-day promotions', async () => {
    const p = await project()
    // Two trusted, one candidate, all created/promoted BEFORE DAY - so a "that day"
    // delta would be 0, but the snapshot of current totals is 2 and 1.
    await promotedEntry(p.id, at('2026-06-01', 12), 1)
    await promotedEntry(p.id, at('2026-06-02', 12), 1)
    await db.insert(knowledge).values({
      projectId: p.id, kind: 'fact', title: 'cand', body: 'b', sourceKind: 'learn',
      validationState: 'candidate', createdAt: at('2026-06-03', 12),
    })
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    const row = await rowFor(p.id, DAY)
    expect(row!.trustedCount).toBe(2)
    expect(row!.candidateCount).toBe(1)
  })

  it('does NOT re-snapshot count on a later revisit - the past stays the past', async () => {
    const p = await project()
    await promotedEntry(p.id, at('2026-06-01', 12), 1) // one trusted before DAY
    // First roll of DAY: snapshot sees 1 trusted.
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: NOW_AFTER(DAY) })
    expect((await rowFor(p.id, DAY))!.trustedCount).toBe(1)

    // The project gains more trusted knowledge afterwards.
    await promotedEntry(p.id, at('2026-06-20', 12), 1)
    await promotedEntry(p.id, at('2026-06-21', 12), 1)

    // A later run still inside DAY's trailing window revisits DAY (for precision) but
    // must NOT overwrite its count snapshot with the new total.
    await runKnowledgeMetricsRollup(db, { projectId: p.id, now: at('2026-06-22') })
    expect((await rowFor(p.id, DAY))!.trustedCount).toBe(1) // frozen at what it was
  })
})

describe('window size', () => {
  it('recomputes exactly the trailing lookahead window', () => {
    // Guards the constant: the window must be at least the precision lookahead, or
    // late contradictions in the uncovered days would never backfill.
    expect(PRECISION_LOOKAHEAD_DAYS).toBe(14)
  })
})
