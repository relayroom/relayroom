/**
 * Pure helpers for the daily knowledge-metrics rollup (FEAT-0001 L2).
 *
 * Split out because they carry no database and no policy: a UTC day boundary and a
 * percentile are the kind of thing that has one correct answer and is worth pinning
 * on its own. The rollup's definitions live in design 04; these are the arithmetic
 * underneath them.
 */

/**
 * The [start, end) UTC instants of a calendar day given as `YYYY-MM-DD`.
 *
 * UTC, never local: a project's day must start at the same instant everywhere, or
 * two projects on the same wall-clock date would be summing different sets of
 * events. `end` is the start of the NEXT day, so day membership is a half-open
 * `start <= t < end` and an event at midnight belongs to exactly one day.
 */
export function utcDayRange(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) throw new Error(`invalid day: ${day}`)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

/** `YYYY-MM-DD` for the UTC day containing `t`. The key metric rows are stored under. */
export function utcDayString(t: Date): string {
  return t.toISOString().slice(0, 10)
}

/** The UTC day string `n` days before `day` (n may be 0). */
export function addUtcDays(day: string, n: number): string {
  const { start } = utcDayRange(day)
  return utcDayString(new Date(start.getTime() + n * 24 * 60 * 60 * 1000))
}

/**
 * The p50 (median) of a sample, or null for an empty one.
 *
 * Linear interpolation between the two middle values on an even count, so the
 * median of [1, 2, 3, 4] is 2.5 rather than an arbitrary pick of 2 or 3. Null on an
 * empty sample so the caller stores null rather than a made-up 0 - "no promotions
 * that day" is not "promotions took zero hours".
 */
export function p50(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = (sorted.length - 1) / 2
  const lo = Math.floor(mid)
  const hi = Math.ceil(mid)
  if (lo === hi) return sorted[lo]!
  return (sorted[lo]! + sorted[hi]!) / 2
}
