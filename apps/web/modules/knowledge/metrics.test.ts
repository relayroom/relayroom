/**
 * The Learning panel's honesty rules, tested as pure logic (no DB).
 *
 * These are the assertions the slice exists to guarantee: a number appears only
 * with enough sample behind it, a ratio is never taken over zero, and the recent
 * precision tail is not counted into the headline. Each is checked in both
 * directions - below the line hides the number, above it shows it - because a
 * gate that only ever hides is as useless as one that never does.
 */
import { describe, expect, it } from "vitest"
import {
  gateRate,
  gateP50,
  foldHeadline,
  isPrecisionProvisional,
  SAMPLE_THRESHOLDS,
  PRECISION_SETTLE_DAYS,
  type MetricDay,
} from "./metrics"

function emptyDay(day: string, over: Partial<MetricDay> = {}): MetricDay {
  return {
    day,
    normalizationVersion: 1,
    repeatErrorNum: null, repeatErrorDen: null,
    recallHitNum: null, recallHitDen: null,
    precisionNum: null, precisionDen: null,
    candidateToTrustedP50Hours: null,
    trustedCount: null, candidateCount: null,
    ...over,
  }
}

/** N days ending today (UTC), oldest first. */
function daySeries(todayUtc: string, n: number, make: (i: number, day: string) => MetricDay): MetricDay[] {
  const rows: MetricDay[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(`${todayUtc}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - i)
    const day = d.toISOString().slice(0, 10)
    rows.push(make(i, day))
  }
  return rows
}

describe("gateRate", () => {
  it("shows the ratio when the sample meets the threshold", () => {
    const r = gateRate(30, 100, 100, SAMPLE_THRESHOLDS.recall)
    expect(r.enough).toBe(true)
    if (r.enough) expect(r.ratio).toBeCloseTo(0.3)
  })

  it("hides the ratio below the sample threshold (never a percentage)", () => {
    const r = gateRate(5, 10, 10, SAMPLE_THRESHOLDS.recall) // 10 < 50
    expect(r.enough).toBe(false)
    if (!r.enough) expect(r.sample).toBe(10)
  })

  it("treats den==0 as not-enough-data, not 0%", () => {
    const r = gateRate(0, 0, 999, SAMPLE_THRESHOLDS.recall)
    expect(r.enough).toBe(false)
  })

  it("does not divide by zero even above the sample threshold", () => {
    const r = gateRate(0, 0, 100, SAMPLE_THRESHOLDS.recall)
    expect(r.enough).toBe(false) // sample is fine, den is not
  })
})

describe("gateP50", () => {
  it("shows hours above the promotion threshold", () => {
    const r = gateP50(12.5, SAMPLE_THRESHOLDS.promotion)
    expect(r.enough).toBe(true)
    if (r.enough) expect(r.hours).toBe(12.5)
  })
  it("hides below it, and when the value is null", () => {
    expect(gateP50(12.5, 3).enough).toBe(false)
    expect(gateP50(null, 999).enough).toBe(false)
  })
})

describe("foldHeadline aggregates over the window", () => {
  const today = "2026-07-24"

  it("sums num/den across days and divides once (a period rate)", () => {
    // Two days, 10/40 and 20/60 -> 30/100 = 0.3, not mean(0.25, 0.33).
    const rows: MetricDay[] = [
      emptyDay("2026-07-22", { recallHitNum: 10, recallHitDen: 40 }),
      emptyDay("2026-07-23", { recallHitNum: 20, recallHitDen: 60 }),
    ]
    const h = foldHeadline(rows, today)
    expect(h.recallHit.enough).toBe(true)
    if (h.recallHit.enough) expect(h.recallHit.ratio).toBeCloseTo(0.3)
  })

  it("gates recall on total recalls in the window", () => {
    const rows = daySeries(today, 30, (_, day) =>
      emptyDay(day, { recallHitNum: 1, recallHitDen: 1 }), // 30 recalls < 50
    )
    const h = foldHeadline(rows, today)
    expect(h.recallHit.enough).toBe(false)
  })

  it("gates precision on the trusted snapshot, from the latest row", () => {
    // Old settled days carry precision; the newest row carries the snapshot.
    const rows = daySeries(today, 30, (i, day) =>
      emptyDay(day, {
        precisionNum: 0, precisionDen: 2,
        trustedCount: i === 0 ? 25 : 5, // latest (i==0) snapshot is 25 >= 20
      }),
    )
    const h = foldHeadline(rows, today)
    expect(h.precision.enough).toBe(true)
    if (h.precision.enough) expect(h.precision.sample).toBe(25)
  })

  it("excludes the unsettled tail from the precision headline", () => {
    // Settled days (older than 14d) all clean (0 contradictions); recent days all
    // dirty. If the headline counted recent days it would look worse. It must not.
    const rows = daySeries(today, 30, (i, day) => {
      const provisional = i < PRECISION_SETTLE_DAYS
      return emptyDay(day, {
        precisionNum: provisional ? 10 : 0, // contradictions only in the recent tail
        precisionDen: 10,
        trustedCount: 40,
      })
    })
    const h = foldHeadline(rows, today)
    expect(h.precision.enough).toBe(true)
    // Settled days contributed 0 contradictions over their denominators -> ratio 0.
    if (h.precision.enough) expect(h.precision.ratio).toBe(0)
  })

  it("surfaces multiple normalization versions in the window", () => {
    const rows: MetricDay[] = [
      emptyDay("2026-07-01", { normalizationVersion: 1 }),
      emptyDay("2026-07-20", { normalizationVersion: 2 }),
    ]
    expect(foldHeadline(rows, today).normalizationVersions).toEqual([1, 2])
  })

  it("takes counts from the latest row as a snapshot, not a sum", () => {
    const rows: MetricDay[] = [
      emptyDay("2026-07-22", { trustedCount: 18, candidateCount: 3 }),
      emptyDay("2026-07-23", { trustedCount: 22, candidateCount: 5 }),
    ]
    const h = foldHeadline(rows, today)
    expect(h.trustedCount).toBe(22)   // latest, not 40
    expect(h.candidateCount).toBe(5)
  })

  it("says not-enough-data for an empty window without throwing", () => {
    const h = foldHeadline([], today)
    expect(h.recallHit.enough).toBe(false)
    expect(h.precision.enough).toBe(false)
    expect(h.trustedCount).toBeNull()
    expect(h.daysPresent).toBe(0)
  })
})

describe("isPrecisionProvisional", () => {
  const today = "2026-07-24"
  it("marks days within the settle window provisional", () => {
    expect(isPrecisionProvisional("2026-07-24", today)).toBe(true)
    expect(isPrecisionProvisional("2026-07-20", today)).toBe(true) // 4d ago
  })
  it("marks older days settled", () => {
    expect(isPrecisionProvisional("2026-07-01", today)).toBe(false) // 23d ago
  })
})
