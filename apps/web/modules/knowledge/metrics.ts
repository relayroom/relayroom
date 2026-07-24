/**
 * The honesty rules of the Learning panel, as pure functions.
 *
 * This module holds no database and no rendering - just the decision of whether
 * a metric may be shown as a number at all, and what that number is. It is the
 * heart of the slice (04 "Honesty rules"), so it is the part that is unit-tested
 * directly: a metric shown below its sample threshold, or computed by dividing by
 * zero, is exactly the dishonesty the panel exists to prevent.
 */

/**
 * Sample-size thresholds below which a metric renders "not enough data" instead
 * of a number.
 *
 * CHOSEN, NOT SPECIFIED by 04. The design gives "e.g. < 20 trusted or < 50
 * recalls" as examples and none for the other two. They are pinned here as real
 * values because a gating threshold cannot be an example - it is what decides
 * whether a number is honest to show. `trusted` and `recall` are 04's example
 * numbers taken as binding; `error` and `promotion` are chosen to match their
 * spirit (a couple dozen observations before a rate means anything).
 *
 * These thresholds are part of the normalization contract: moving one moves the
 * boundary of "not enough data", so a change here changes the gating history and
 * should bump NORMALIZATION alongside the rollup's own version.
 */
export const SAMPLE_THRESHOLDS = {
  /** knowledge_precision gates on trusted-entry total (snapshot). */
  trusted: 20,
  /** recall_hit_rate gates on recall_log rows in the window. */
  recall: 50,
  /** repeat_error_rate gates on error events in the window. */
  error: 20,
  /** candidate_to_trusted_p50 gates on promotions in the window. */
  promotion: 20,
} as const

/**
 * The window the headline aggregate sums over.
 *
 * CHOSEN, window=30d. 04 does not give a number. 30 days lets an active project
 * accumulate the 50-recall threshold at ~1.7 recalls/day while a dormant one
 * honestly stays below it and reads "not enough data". Like the thresholds, this
 * shapes gating, so a change is a normalization change.
 */
export const HEADLINE_WINDOW_DAYS = 30

/**
 * How long after promotion a contradiction can still arrive, so precision over
 * the most recent 14 days is not yet settled - it looks better than it will end
 * up, because the bad news is still in flight. The panel marks that tail
 * provisional and computes the precision headline from settled days only.
 */
export const PRECISION_SETTLE_DAYS = 14

/** Increment when a threshold, window, or metric definition here changes. */
export const NORMALIZATION = 1

// ── Rate gating ────────────────────────────────────────────────────────────────

export type MetricDisplay =
  | { enough: true; ratio: number; num: number; den: number; sample: number }
  | { enough: false; sample: number; threshold: number }

/**
 * Decide whether an aggregated rate may be shown.
 *
 * `sample` is what the honesty rule counts (recalls, errors, promotions, or the
 * trusted snapshot) - NOT necessarily the denominator. den==0 is "not enough
 * data" too: a ratio over nothing is not 0%, it is unknown, and showing 0% would
 * read as a real, good result.
 */
export function gateRate(
  num: number | null | undefined,
  den: number | null | undefined,
  sample: number | null | undefined,
  threshold: number,
): MetricDisplay {
  const s = sample ?? 0
  const d = den ?? 0
  const n = num ?? 0
  if (s < threshold || d <= 0) {
    return { enough: false, sample: s, threshold }
  }
  return { enough: true, ratio: n / d, num: n, den: d, sample: s }
}

export type P50Display =
  | { enough: true; hours: number; sample: number }
  | { enough: false; sample: number; threshold: number }

/** p50 is a duration, not a rate: gate on the promotion count, show hours. */
export function gateP50(
  hours: number | null | undefined,
  sample: number | null | undefined,
): P50Display {
  const s = sample ?? 0
  if (s < SAMPLE_THRESHOLDS.promotion || hours == null) {
    return { enough: false, sample: s, threshold: SAMPLE_THRESHOLDS.promotion }
  }
  return { enough: true, hours, sample: s }
}

// ── Aggregation over the window ────────────────────────────────────────────────

/** One rolled-up day, as read from knowledge_metric_daily. */
export interface MetricDay {
  day: string
  normalizationVersion: number
  repeatErrorNum: number | null
  repeatErrorDen: number | null
  recallHitNum: number | null
  recallHitDen: number | null
  precisionNum: number | null
  precisionDen: number | null
  candidateToTrustedP50Hours: number | null
  trustedCount: number | null
  candidateCount: number | null
}

function sum(rows: MetricDay[], pick: (r: MetricDay) => number | null): number {
  return rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0)
}

/** Median of a numeric list, or null when empty. Used to headline the p50 series. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

export interface LearningHeadline {
  repeatError: MetricDisplay
  recallHit: MetricDisplay
  /** Precision headline is over SETTLED days only (older than PRECISION_SETTLE_DAYS). */
  precision: MetricDisplay
  candidateToTrustedP50: P50Display
  /** Latest snapshot totals, for context and the trusted gate. null if no rows. */
  trustedCount: number | null
  candidateCount: number | null
  /** Distinct normalization versions present in the window; >1 means the definition moved. */
  normalizationVersions: number[]
  /** Days actually present in the window - the window may be sparser than its length. */
  daysPresent: number
}

/**
 * Fold a window of daily rows into the four headline figures.
 *
 * Rates sum num and den across the window and divide once - a period rate, not a
 * mean of daily rates (which would weight a quiet day equally with a busy one).
 * Precision is special: its headline excludes the unsettled tail so a recent,
 * optimistic-by-construction value is never presented as the number.
 *
 * `todayUtc` is passed in (not read from a clock) so this stays pure and
 * testable; callers hand it the current UTC date string.
 */
export function foldHeadline(rows: MetricDay[], todayUtc: string): LearningHeadline {
  const trustedSnapshot = rows.length > 0 ? (rows[rows.length - 1]!.trustedCount ?? 0) : null

  // Settled cutoff for precision: strictly older than PRECISION_SETTLE_DAYS ago.
  const cutoff = new Date(`${todayUtc}T00:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - PRECISION_SETTLE_DAYS)
  const settled = rows.filter((r) => new Date(`${r.day}T00:00:00Z`) < cutoff)

  return {
    repeatError: gateRate(
      sum(rows, (r) => r.repeatErrorNum),
      sum(rows, (r) => r.repeatErrorDen),
      sum(rows, (r) => r.repeatErrorDen),
      SAMPLE_THRESHOLDS.error,
    ),
    recallHit: gateRate(
      sum(rows, (r) => r.recallHitNum),
      sum(rows, (r) => r.recallHitDen),
      sum(rows, (r) => r.recallHitDen),
      SAMPLE_THRESHOLDS.recall,
    ),
    precision: gateRate(
      sum(settled, (r) => r.precisionNum),
      sum(settled, (r) => r.precisionDen),
      // Precision gates on the trusted snapshot, and only settled days count.
      trustedSnapshot,
      SAMPLE_THRESHOLDS.trusted,
    ),
    candidateToTrustedP50: gateP50(
      median(rows.map((r) => r.candidateToTrustedP50Hours).filter((h): h is number => h != null)),
      sum(rows, (r) => (r.candidateToTrustedP50Hours != null ? 1 : 0)),
    ),
    trustedCount: trustedSnapshot,
    candidateCount: rows.length > 0 ? (rows[rows.length - 1]!.candidateCount ?? 0) : null,
    normalizationVersions: [...new Set(rows.map((r) => r.normalizationVersion))].sort((a, b) => a - b),
    daysPresent: rows.length,
  }
}

/**
 * Whether a given day falls in the unsettled precision tail - the sparkline draws
 * these as provisional. A day is provisional when it is within
 * PRECISION_SETTLE_DAYS of today.
 */
export function isPrecisionProvisional(day: string, todayUtc: string): boolean {
  const cutoff = new Date(`${todayUtc}T00:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - PRECISION_SETTLE_DAYS)
  return new Date(`${day}T00:00:00Z`) >= cutoff
}
