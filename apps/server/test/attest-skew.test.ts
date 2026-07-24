/**
 * Clock-skew bound on attestation issuedAt (FEAT-0001 L1). Pure, so it is tested
 * against a fixed `now` rather than the wall clock.
 */
import { describe, expect, it } from 'vitest'
import { ATTEST_SKEW_SECONDS, checkAttestSkew } from '../src/knowledge/attest-skew'

const NOW = new Date('2026-07-24T12:00:00.000Z')
const at = (secondsFromNow: number) => new Date(NOW.getTime() + secondsFromNow * 1000).toISOString()

describe('checkAttestSkew', () => {
  it('accepts a timestamp at now', () => {
    expect(checkAttestSkew(at(0), NOW)).toEqual({ ok: true, issuedAt: new Date(at(0)) })
  })

  it('accepts up to the window on both sides', () => {
    expect(checkAttestSkew(at(-ATTEST_SKEW_SECONDS), NOW).ok).toBe(true)
    expect(checkAttestSkew(at(ATTEST_SKEW_SECONDS), NOW).ok).toBe(true)
  })

  it('rejects a stale timestamp past the window', () => {
    expect(checkAttestSkew(at(-ATTEST_SKEW_SECONDS - 1), NOW)).toEqual({ ok: false, reason: 'skew' })
  })

  it('rejects a future timestamp past the window, not just a past one', () => {
    // A future issuedAt is a skewed CI clock or an attempt to outlive the window.
    expect(checkAttestSkew(at(ATTEST_SKEW_SECONDS + 1), NOW)).toEqual({ ok: false, reason: 'skew' })
  })

  it('separates a non-timestamp from a stale one', () => {
    expect(checkAttestSkew('not-a-date', NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(checkAttestSkew('', NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('honors a custom window', () => {
    expect(checkAttestSkew(at(-120), NOW, 60)).toEqual({ ok: false, reason: 'skew' })
    expect(checkAttestSkew(at(-30), NOW, 60).ok).toBe(true)
  })
})
