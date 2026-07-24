/**
 * The canonical signing target for CI attestations (FEAT-0001 L1).
 *
 * This encoding is the single source of truth (design 04). A CI job signs the
 * exact bytes this produces, and the server reconstructs the identical string to
 * verify - so if the two sides ever disagree by a character, every real
 * attestation fails closed rather than a forged one passing. Everything about it
 * is therefore deliberate and must not be "tidied":
 *
 *   - the EIGHT fields appear in this FIXED order, never sorted, never the object's
 *     insertion order;
 *   - no whitespace between tokens;
 *   - values are JSON-escaped (JSON.stringify per value), so a quote or backslash
 *     inside runId or checkName cannot break out of its field and forge another.
 *
 * It is NOT `JSON.stringify(wholeObject)`: that would leave field order at the
 * mercy of how the object was built and would silently include any extra key. This
 * lists the fields explicitly, which is the point - an attestation carrying an
 * ninth field signs the same eight, and the ninth cannot influence the signature.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** The signed fields, in the one order that is valid. */
export interface AttestClaim {
  projectId: string
  knowledgeId: string
  runId: string
  checkName: string
  assertion: string
  keyId: string
  issuedAt: string
  nonce: string
}

/** Field order is load-bearing - see the file header. Do not reorder or derive. */
const CANONICAL_FIELDS: (keyof AttestClaim)[] = [
  'projectId', 'knowledgeId', 'runId', 'checkName', 'assertion', 'keyId', 'issuedAt', 'nonce',
]

/**
 * Build the exact string that gets signed: `{"projectId":"...","knowledgeId":...}`
 * with the fields in CANONICAL_FIELDS order and each value JSON-escaped. Hand-built
 * rather than via JSON.stringify(object) so the order can never depend on how the
 * caller assembled its object.
 */
export function canonicalAttestString(claim: AttestClaim): string {
  const parts = CANONICAL_FIELDS.map(
    f => `${JSON.stringify(f)}:${JSON.stringify(claim[f])}`,
  )
  return `{${parts.join(',')}}`
}

/** Lowercase hex HMAC-SHA256 of the canonical string under `secret`. */
export function signAttest(claim: AttestClaim, secret: string): string {
  return createHmac('sha256', secret).update(canonicalAttestString(claim)).digest('hex')
}

/**
 * Constant-time check of a hex signature against `secret`. Length-guarded first
 * because timingSafeEqual throws on a length mismatch, and returns false on any
 * malformed input rather than letting a bad hex string surface as a 500.
 */
export function verifyAttest(claim: AttestClaim, secret: string, signatureHex: string): boolean {
  const expected = signAttest(claim, secret)
  if (typeof signatureHex !== 'string' || signatureHex.length !== expected.length) return false
  let a: Buffer
  let b: Buffer
  try {
    a = Buffer.from(expected, 'hex')
    b = Buffer.from(signatureHex, 'hex')
  }
  catch {
    return false
  }
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}
