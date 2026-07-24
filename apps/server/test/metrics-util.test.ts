/**
 * Pure arithmetic under the metrics rollup (FEAT-0001 L2): UTC day boundaries and
 * the p50. Tested against fixed inputs, no clock and no database.
 */
import { describe, expect, it } from 'vitest'
import { addUtcDays, p50, utcDayRange, utcDayString } from '../src/knowledge/metrics-util'

describe('utcDayRange', () => {
  it('spans one UTC day as a half-open interval', () => {
    const { start, end } = utcDayRange('2026-07-24')
    expect(start.toISOString()).toBe('2026-07-24T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-07-25T00:00:00.000Z')
  })

  it('rejects a malformed day', () => {
    expect(() => utcDayRange('not-a-day')).toThrow()
  })
})

describe('utcDayString', () => {
  it('is UTC, not local - an instant just before UTC midnight is the earlier day', () => {
    expect(utcDayString(new Date('2026-07-24T23:59:59.999Z'))).toBe('2026-07-24')
    expect(utcDayString(new Date('2026-07-25T00:00:00.000Z'))).toBe('2026-07-25')
  })
})

describe('addUtcDays', () => {
  it('walks days including across a month boundary', () => {
    expect(addUtcDays('2026-07-24', -13)).toBe('2026-07-11')
    expect(addUtcDays('2026-08-01', -1)).toBe('2026-07-31')
    expect(addUtcDays('2026-07-24', 0)).toBe('2026-07-24')
  })
})

describe('p50', () => {
  it('is null for an empty sample, not zero', () => {
    // "no promotions that day" must not read as "promotions took zero hours".
    expect(p50([])).toBeNull()
  })

  it('is the middle of an odd-length sample', () => {
    expect(p50([3, 1, 2])).toBe(2)
  })

  it('interpolates the two middles on an even-length sample', () => {
    expect(p50([1, 2, 3, 4])).toBe(2.5)
  })

  it('handles a single value', () => {
    expect(p50([7])).toBe(7)
  })
})
