/**
 * The canonical attestation encoding (FEAT-0001 L1).
 *
 * This is the single source of truth both sides sign against, so the tests pin the
 * exact bytes and the two failure modes that matter: any field tampering breaks the
 * signature, and a quote inside a value cannot forge a different field.
 */
import { describe, expect, it } from 'vitest'
import {
  type AttestClaim,
  canonicalAttestString,
  signAttest,
  verifyAttest,
} from '../src/knowledge/attest-canonical'

const claim: AttestClaim = {
  projectId: 'p1',
  knowledgeId: 'k1',
  runId: 'run-42',
  checkName: 'migration-smoke',
  assertion: 'check_passed',
  keyId: 'key-a',
  issuedAt: '2026-07-24T00:00:00.000Z',
  nonce: 'n-abc',
}

describe('canonicalAttestString', () => {
  it('emits the seven fields in the fixed order with no whitespace', () => {
    expect(canonicalAttestString(claim)).toBe(
      '{"projectId":"p1","knowledgeId":"k1","runId":"run-42","checkName":"migration-smoke",'
      + '"assertion":"check_passed","keyId":"key-a","issuedAt":"2026-07-24T00:00:00.000Z","nonce":"n-abc"}',
    )
  })

  it('does not depend on the object\'s key order', () => {
    // A CI client may build the object in any order; the signature must not care.
    const shuffled = {
      nonce: 'n-abc', assertion: 'check_passed', projectId: 'p1', keyId: 'key-a',
      issuedAt: '2026-07-24T00:00:00.000Z', checkName: 'migration-smoke', knowledgeId: 'k1', runId: 'run-42',
    } as AttestClaim
    expect(canonicalAttestString(shuffled)).toBe(canonicalAttestString(claim))
  })

  it('ignores extra keys the type does not name', () => {
    const withExtra = { ...claim, evil: 'injected' } as AttestClaim & { evil: string }
    expect(canonicalAttestString(withExtra)).toBe(canonicalAttestString(claim))
  })

  it('escapes a value so it cannot break out of its field', () => {
    // A checkName containing a quote must stay inside the checkName field rather
    // than closing it and opening a forged one.
    const tricky: AttestClaim = { ...claim, checkName: 'a","knowledgeId":"k2' }
    const s = canonicalAttestString(tricky)
    // The injected quotes are escaped, so the whole thing stays inside checkName.
    expect(s).toContain('"checkName":"a\\",\\"knowledgeId\\":\\"k2"')
    // The real knowledgeId field is still k1, unaffected by the injection attempt.
    expect(s).toContain('"knowledgeId":"k1"')
    // And the payload still round-trips as one object with the honest values.
    expect(JSON.parse(s).knowledgeId).toBe('k1')
    expect(JSON.parse(s).checkName).toBe('a","knowledgeId":"k2')
  })
})

describe('signAttest / verifyAttest', () => {
  const secret = 'super-secret'

  it('verifies a signature it produced', () => {
    expect(verifyAttest(claim, secret, signAttest(claim, secret))).toBe(true)
  })

  it('rejects a different secret', () => {
    expect(verifyAttest(claim, 'other-secret', signAttest(claim, secret))).toBe(false)
  })

  it('rejects when ANY field is tampered', () => {
    const sig = signAttest(claim, secret)
    for (const field of Object.keys(claim) as (keyof AttestClaim)[]) {
      const tampered = { ...claim, [field]: `${claim[field]}-x` }
      expect(verifyAttest(tampered, secret, sig), `tampering ${field} still verified`).toBe(false)
    }
  })

  it('rejects a malformed signature instead of throwing', () => {
    expect(verifyAttest(claim, secret, 'not-hex')).toBe(false)
    expect(verifyAttest(claim, secret, '')).toBe(false)
    expect(verifyAttest(claim, secret, 'abcd')).toBe(false)
  })
})
