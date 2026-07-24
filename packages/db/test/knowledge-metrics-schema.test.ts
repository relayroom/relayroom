import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { getOrCreateProject } from '../src/bootstrap'
import { knowledgeMetricDaily } from '../src/schema'

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
 * The metrics table exists to keep the Learning panel honest, so these assert the
 * two properties that honesty rests on: a metric with no data is null (a real zero
 * and "no data" must stay distinguishable, or the panel shows 0% where it should
 * show "not enough data"), and there is exactly one row per project per day, so a
 * rollup re-run overwrites rather than double-counts.
 */
describe('knowledge_metric_daily schema', () => {
  it('defaults the normalization version and leaves every metric null', async () => {
    // A definition change is meant to show up as a version break in the series, so
    // the version is never absent. Metrics not computed that day stay null - "no
    // data", not zero.
    const project = await getOrCreateProject(db, 'km-defaults')
    await db.insert(knowledgeMetricDaily).values({ projectId: project.id, day: '2026-07-24' })
    const [row] = await db.select().from(knowledgeMetricDaily)
      .where(and(eq(knowledgeMetricDaily.projectId, project.id), eq(knowledgeMetricDaily.day, '2026-07-24')))
    expect(row!.normalizationVersion).toBe(1)
    expect(row!.recallHitNum).toBeNull()
    expect(row!.recallHitDen).toBeNull()
    expect(row!.precisionNum).toBeNull()
    expect(row!.trustedCount).toBeNull()
    expect(row!.candidateToTrustedP50Hours).toBeNull()
  })

  it('stores raw numerator and denominator, not a ratio', async () => {
    // The whole reason the columns are counts: a stored rate cannot be
    // re-aggregated across days and hides the sample size the panel gates on.
    const project = await getOrCreateProject(db, 'km-raw')
    await db.insert(knowledgeMetricDaily).values({
      projectId: project.id, day: '2026-07-24',
      repeatErrorNum: 2, repeatErrorDen: 9,
      recallHitNum: 3, recallHitDen: 10,
      precisionNum: 0, precisionDen: 4,        // a real zero numerator over a real denominator
      candidateToTrustedP50Hours: 6.5, trustedCount: 12, candidateCount: 30,
    })
    const [row] = await db.select().from(knowledgeMetricDaily)
      .where(eq(knowledgeMetricDaily.projectId, project.id))
    expect(row).toMatchObject({
      repeatErrorNum: 2, repeatErrorDen: 9,
      recallHitNum: 3, recallHitDen: 10,
      precisionNum: 0, precisionDen: 4,
      trustedCount: 12, candidateCount: 30,
    })
    expect(row!.candidateToTrustedP50Hours).toBeCloseTo(6.5)
  })

  it('keeps one row per project per day', async () => {
    // A rollup re-run for the same day must collide, so it can upsert rather than
    // append a second, double-counted row.
    const project = await getOrCreateProject(db, 'km-pk')
    const day = { projectId: project.id, day: '2026-07-24' as const }
    await db.insert(knowledgeMetricDaily).values(day)
    const err = await rejection(() => db.insert(knowledgeMetricDaily).values(day))
    expect(err).toContain('knowledge_metric_daily_project_id_day_pk')
  })

  it('separates the same day across projects', async () => {
    const a = await getOrCreateProject(db, 'km-proj-a')
    const b = await getOrCreateProject(db, 'km-proj-b')
    await db.insert(knowledgeMetricDaily).values({ projectId: a.id, day: '2026-07-24', trustedCount: 1 })
    await db.insert(knowledgeMetricDaily).values({ projectId: b.id, day: '2026-07-24', trustedCount: 2 })
    const rows = await db.select().from(knowledgeMetricDaily).where(eq(knowledgeMetricDaily.day, '2026-07-24'))
    const mine = rows.filter(r => r.projectId === a.id || r.projectId === b.id)
    expect(mine.map(r => r.trustedCount).sort()).toEqual([1, 2])
  })
})
