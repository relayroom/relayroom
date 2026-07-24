/**
 * Clock-skew check for an attestation's issuedAt (FEAT-0001 L1).
 *
 * Replay defense has two halves: a nonce that can only be spent once (DB), and a
 * time window that bounds how long a captured request stays spendable at all. This
 * is the second half. Kept pure so the window logic is testable without a clock or
 * a database, and so the endpoint has one place that decides "too old / too new".
 *
 * The window is symmetric: a timestamp too far in the FUTURE is rejected too, not
 * just one too far in the past. A future issuedAt is either a badly-skewed CI clock
 * or an attempt to keep a request valid longer than the window allows, and neither
 * is something to accept.
 */

/** Default tolerance on either side of now, in seconds (design 04). */
export const ATTEST_SKEW_SECONDS = 300

export type SkewResult =
  | { ok: true; issuedAt: Date }
  | { ok: false; reason: 'malformed' | 'skew' }

/**
 * Parse `issuedAt` and check it sits within `skewSeconds` of `now`.
 *
 * `malformed` is separated from `skew` so the endpoint can answer 400 for a value
 * that is not a timestamp and reserve the skew case for a real-but-stale one - a
 * garbage string and a two-hour-old request are different client mistakes.
 */
export function checkAttestSkew(
  issuedAt: string,
  now: Date,
  skewSeconds: number = ATTEST_SKEW_SECONDS,
): SkewResult {
  if (typeof issuedAt !== 'string' || issuedAt.trim() === '') {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = new Date(issuedAt)
  const ms = parsed.getTime()
  if (Number.isNaN(ms)) return { ok: false, reason: 'malformed' }

  if (Math.abs(ms - now.getTime()) > skewSeconds * 1000) {
    return { ok: false, reason: 'skew' }
  }
  return { ok: true, issuedAt: parsed }
}
