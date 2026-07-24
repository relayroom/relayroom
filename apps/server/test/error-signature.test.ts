/**
 * The shared error-event signature (FEAT-0001). Pure; the L2 metric and the L4
 * clusterer both bucket on this, so its behaviour is pinned once here.
 */
import { describe, expect, it } from 'vitest'
import { ERROR_SIGNATURE_VERSION, errorSignature } from '../src/knowledge/error-signature'

describe('errorSignature', () => {
  it('buckets two errors with the same code + area together', () => {
    const a = errorSignature({ code: 'E_TIMEOUT', area: 'payments' })
    const b = errorSignature({ code: 'E_TIMEOUT', area: 'payments' })
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('normalizes case and whitespace before bucketing', () => {
    expect(errorSignature({ code: '  E_Timeout ', area: 'Payments' }))
      .toBe(errorSignature({ code: 'e_timeout', area: 'payments' }))
  })

  it('separates different codes and different areas', () => {
    const base = errorSignature({ code: 'E_TIMEOUT', area: 'payments' })
    expect(errorSignature({ code: 'E_OTHER', area: 'payments' })).not.toBe(base)
    expect(errorSignature({ code: 'E_TIMEOUT', area: 'billing' })).not.toBe(base)
  })

  it('falls back code -> errorClass -> first message line', () => {
    expect(errorSignature({ errorClass: 'TimeoutError', area: 'x' })).not.toBeNull()
    const fromMsg = errorSignature({ message: 'connection reset\nat foo()', area: 'x' })
    // Only the first line participates, so a differing stack tail does not split it.
    expect(fromMsg).toBe(errorSignature({ message: 'connection reset\nat bar()', area: 'x' }))
  })

  it('is null when there is nothing to bucket on', () => {
    // A detail with no identifying field must not be a repeat of another empty one.
    expect(errorSignature({})).toBeNull()
    expect(errorSignature(null)).toBeNull()
    expect(errorSignature({ unrelated: 'field' })).toBeNull()
    expect(errorSignature({ code: '   ' })).toBeNull()
  })

  it('signs with only what or only where present', () => {
    expect(errorSignature({ code: 'E_X' })).not.toBeNull()
    expect(errorSignature({ area: 'payments' })).not.toBeNull()
    // and those two are different buckets
    expect(errorSignature({ code: 'E_X' })).not.toBe(errorSignature({ area: 'E_X' }))
  })

  it('exposes a version that travels with the definition', () => {
    expect(ERROR_SIGNATURE_VERSION).toBe(1)
  })
})
