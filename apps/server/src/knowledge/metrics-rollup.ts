/**
 * Daily knowledge-metrics rollup (FEAT-0001 L2).
 *
 * Computes, per project per UTC day, the four metrics of design 04 and upserts them
 * into knowledge_metric_daily as RAW numerator/denominator pairs (not ratios), so a
 * definition change is detectable via normalization_version and any day is
 * recomputable from the source rows.
 *
 * HONESTY (design 04, and it belongs in the code, not only the doc). All four
 * metrics derive from AGENT-POSTED TELEMETRY - events and recall logs arrive over
 * MCP from agents - so none is tamper-proof and none is ground truth. repeat_error
 * and precision are cross-agent (harder for one agent to move alone) but still
 * agent-sourced. The dashboard must label them as agent-reported and never present
 * a percentage as fact. Nothing here mixes one project's data with another's: every
 * query is scoped to a single projectId, so there is no cross-project comparison to
 * accidentally make.
 *
 * PRECISION IS NOT FINAL FOR 14 DAYS. Its numerator counts contradictions arriving
 * within 14 days of promotion, so a contradiction landing today changes the
 * precision of any day in the trailing 14. That is why each run revisits the whole
 * trailing window rather than only yesterday: a late contradiction must backfill.
 * Do NOT "optimize" this to a single-day pass - the recent window would then
 * under-count contradictions and read as better-than-real, which is the exact
 * dishonesty this slice exists to avoid. The display side is responsible for marking
 * the last 14 days as still-accumulating.
 *
 * Only PRECISION is recomputed on a revisit. recall/repeat/p50 are final the moment
 * their day closes, and trusted_count/candidate_count are a one-time snapshot of the
 * project's totals (see computeSnapshotCounts) that must not be rewritten - a past
 * day's snapshot is "what the totals were then", and re-taking it would overwrite
 * that with today's. So a first sighting of a day writes the full row; every later
 * visit touches precision alone.
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { events, knowledge, knowledgeMetricDaily, knowledgeValidations, projects, recallLogs } from '@relayroom/db'
import { ERROR_SIGNATURE_VERSION, errorSignature } from './error-signature'
import { addUtcDays, p50, utcDayRange, utcDayString } from './metrics-util'

/** Days back a contradiction still counts against the precision of a promotion. */
export const PRECISION_LOOKAHEAD_DAYS = 14
/** Days back an error signature counts as a prior appearance for repeat_error. */
export const REPEAT_ERROR_LOOKBACK_DAYS = 7
/** Trailing days recomputed each run - the precision window is what forces it. */
export const ROLLUP_WINDOW_DAYS = PRECISION_LOOKAHEAD_DAYS
/** Projects processed per tick. A cap so one project cannot hold the whole batch. */
export const ROLLUP_PROJECT_BATCH = 100

export interface RollupResult {
  projects: number
  rows: number
}

/**
 * Run the rollup. `now` is injectable for tests; in production it is the wall clock.
 *
 * Recomputes the trailing ROLLUP_WINDOW_DAYS up to and including YESTERDAY (UTC) -
 * today is excluded because it is not a closed day yet. One project may be pinned
 * via opts.projectId (tests); otherwise every project is processed, capped per tick.
 */
export async function runKnowledgeMetricsRollup(
  db: Db,
  opts: { now?: Date; projectId?: string; limit?: number } = {},
): Promise<RollupResult> {
  const now = opts.now ?? new Date()
  const yesterday = utcDayString(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  const days: string[] = []
  for (let i = 0; i < ROLLUP_WINDOW_DAYS; i++) days.push(addUtcDays(yesterday, -i))

  const projectIds = opts.projectId
    ? [opts.projectId]
    : (await db
        .select({ id: projects.id })
        .from(projects)
        .orderBy(projects.id)
        .limit(opts.limit ?? ROLLUP_PROJECT_BATCH)
      ).map(r => r.id)

  let rows = 0
  for (const projectId of projectIds) {
    for (const day of days) {
      await rollupOneDay(db, projectId, day)
      rows++
    }
  }
  return { projects: projectIds.length, rows }
}

/**
 * Two shapes of work, and the difference is the whole point of the corrected
 * design:
 *
 *   - A day whose row does not exist yet (the target day, or one missed during
 *     downtime): compute everything - the four metrics AND the count snapshot - and
 *     insert it. recall/repeat/p50 are final for a closed day; the count snapshot is
 *     taken as-of-now and frozen here.
 *   - A day whose row already exists (every trailing day but the newest): update
 *     ONLY precision. Its other metrics were final when first written, and its count
 *     snapshot is "what the totals were the day it was recorded" - re-snapshotting
 *     would overwrite that with today's totals and make the series lie. Precision is
 *     the sole thing that legitimately changes after the fact, because a
 *     contradiction can arrive up to 14 days after promotion.
 */
async function rollupOneDay(db: Db, projectId: string, day: string): Promise<void> {
  const { start, end } = utcDayRange(day)
  const precision = await computePrecision(db, projectId, start, end)

  const [existing] = await db
    .select({ day: knowledgeMetricDaily.day })
    .from(knowledgeMetricDaily)
    .where(and(eq(knowledgeMetricDaily.projectId, projectId), eq(knowledgeMetricDaily.day, day)))
    .limit(1)

  if (existing) {
    // Precision only. Count and the finalized metrics are left exactly as recorded.
    await db
      .update(knowledgeMetricDaily)
      .set({ precisionNum: precision.num, precisionDen: precision.den })
      .where(and(eq(knowledgeMetricDaily.projectId, projectId), eq(knowledgeMetricDaily.day, day)))
    return
  }

  const [repeatError, recallHit, p50Hours, counts] = await Promise.all([
    computeRepeatError(db, projectId, start, end),
    computeRecallHit(db, projectId, start, end),
    computeP50Hours(db, projectId, start, end),
    computeSnapshotCounts(db, projectId),
  ])

  // insert-if-absent: a concurrent run (the scheduler's re-entrancy guard makes this
  // unlikely, but two projects share the pool) must not double-insert. On conflict,
  // fall to the same precision-only update the existing branch does.
  await db
    .insert(knowledgeMetricDaily)
    .values({
      projectId,
      day,
      normalizationVersion: ERROR_SIGNATURE_VERSION,
      repeatErrorNum: repeatError.num,
      repeatErrorDen: repeatError.den,
      recallHitNum: recallHit.num,
      recallHitDen: recallHit.den,
      precisionNum: precision.num,
      precisionDen: precision.den,
      candidateToTrustedP50Hours: p50Hours,
      trustedCount: counts.trusted,
      candidateCount: counts.candidate,
    })
    .onConflictDoUpdate({
      target: [knowledgeMetricDaily.projectId, knowledgeMetricDaily.day],
      set: { precisionNum: precision.num, precisionDen: precision.den },
    })
}

/**
 * repeat_error_rate. Denominator: every error event that day. Numerator: those
 * whose signature already appeared in the project in the prior 7 days (before this
 * day's window opens). A null-signature error counts in the denominator but never
 * matches. Computed in JS because the signature normalization is one shared
 * definition (errorSignature); pushing it into SQL would fork it.
 */
async function computeRepeatError(
  db: Db, projectId: string, start: Date, end: Date,
): Promise<{ num: number; den: number }> {
  const dayErrors = await db
    .select({ detail: events.detail })
    .from(events)
    .where(and(
      eq(events.projectId, projectId),
      eq(events.type, 'error'),
      gte(events.createdAt, start),
      lt(events.createdAt, end),
    ))
  const den = dayErrors.length
  if (den === 0) return { num: 0, den: 0 }

  const lookbackStart = new Date(start.getTime() - REPEAT_ERROR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const priorErrors = await db
    .select({ detail: events.detail })
    .from(events)
    .where(and(
      eq(events.projectId, projectId),
      eq(events.type, 'error'),
      gte(events.createdAt, lookbackStart),
      lt(events.createdAt, start),
    ))
  const priorSignatures = new Set(
    priorErrors.map(e => errorSignature(e.detail)).filter((s): s is string => s !== null),
  )

  let num = 0
  for (const e of dayErrors) {
    const sig = errorSignature(e.detail)
    if (sig !== null && priorSignatures.has(sig)) num++
  }
  return { num, den }
}

/** recall_hit_rate. Denominator: recall_log rows that day. Numerator: those with a
 *  usedKnowledgeId set. */
async function computeRecallHit(
  db: Db, projectId: string, start: Date, end: Date,
): Promise<{ num: number; den: number }> {
  const [row] = await db
    .select({
      den: sql<number>`count(*)::int`,
      num: sql<number>`count(${recallLogs.usedKnowledgeId})::int`,
    })
    .from(recallLogs)
    .where(and(
      eq(recallLogs.projectId, projectId),
      gte(recallLogs.createdAt, start),
      lt(recallLogs.createdAt, end),
    ))
  return { num: row?.num ?? 0, den: row?.den ?? 0 }
}

/**
 * knowledge_precision. Denominator: entries promoted to trusted THAT day
 * (promoted_at in the window). Numerator: of those, how many received a contradict
 * validation within 14 days of their promotion. The numerator grows for up to 14
 * days after the day - the reason the whole window is recomputed each run.
 */
async function computePrecision(
  db: Db, projectId: string, start: Date, end: Date,
): Promise<{ num: number; den: number }> {
  const promotedThatDay = await db
    .select({ id: knowledge.id, promotedAt: knowledge.promotedAt })
    .from(knowledge)
    .where(and(
      eq(knowledge.projectId, projectId),
      gte(knowledge.promotedAt, start),
      lt(knowledge.promotedAt, end),
    ))
  const den = promotedThatDay.length
  if (den === 0) return { num: 0, den: 0 }

  let num = 0
  for (const entry of promotedThatDay) {
    if (!entry.promotedAt) continue
    const deadline = new Date(entry.promotedAt.getTime() + PRECISION_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000)
    const [contra] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(knowledgeValidations)
      .where(and(
        eq(knowledgeValidations.knowledgeId, entry.id),
        eq(knowledgeValidations.signal, 'contradict'),
        gte(knowledgeValidations.createdAt, entry.promotedAt),
        lt(knowledgeValidations.createdAt, deadline),
      ))
    if ((contra?.n ?? 0) > 0) num++
  }
  return { num, den }
}

/** candidate_to_trusted_p50_hours. p50 of (promotedAt - createdAt) over entries
 *  promoted that day, in hours. null when nothing was promoted. */
async function computeP50Hours(
  db: Db, projectId: string, start: Date, end: Date,
): Promise<number | null> {
  const promoted = await db
    .select({ createdAt: knowledge.createdAt, promotedAt: knowledge.promotedAt })
    .from(knowledge)
    .where(and(
      eq(knowledge.projectId, projectId),
      gte(knowledge.promotedAt, start),
      lt(knowledge.promotedAt, end),
    ))
  const hours = promoted
    .filter(r => r.promotedAt && r.createdAt)
    .map(r => (r.promotedAt!.getTime() - r.createdAt!.getTime()) / 3_600_000)
  return p50(hours)
}

/**
 * trusted_count / candidate_count are a SNAPSHOT of the project's current totals,
 * taken once when the day's row is first written and never rewritten. They answer
 * "how much trusted knowledge exists" - the quantity the honesty gate reads ("< 20
 * trusted entries -> not enough data"), which is a stock, not a flow. Flow is
 * already candidate_to_trusted_p50_hours; count and p50 are split on purpose.
 *
 * A snapshot cannot be reconstructed for a past instant - there is no state history
 * - so it is taken as-of-now and frozen. That is the ONLY honest option, and it is
 * why these two columns are excluded from the trailing recompute (see rollupOneDay):
 * re-snapshotting a past day would overwrite "what it was then" with "what it is
 * now" and the series would lie. Do not add them to the update path.
 */
async function computeSnapshotCounts(
  db: Db, projectId: string,
): Promise<{ trusted: number; candidate: number }> {
  const [row] = await db
    .select({
      trusted: sql<number>`count(*) filter (where ${knowledge.validationState} = 'trusted')::int`,
      candidate: sql<number>`count(*) filter (where ${knowledge.validationState} = 'candidate')::int`,
    })
    .from(knowledge)
    .where(eq(knowledge.projectId, projectId))
  return { trusted: row?.trusted ?? 0, candidate: row?.candidate ?? 0 }
}
