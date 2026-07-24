/**
 * The error-event signature (FEAT-0001, design 04).
 *
 * A "signature" buckets error events coarsely so recurrence can be counted: two
 * errors with the same signature are treated as the same failure. The L2
 * repeat_error_rate metric counts a signature that already appeared in the prior 7
 * days, and the L4 clusterer (not built yet) will draft a pitfall from a signature
 * that recurs. BOTH must bucket errors the same way, so the definition lives here,
 * once, for both to import - not copied into each. Two copies would drift, and a
 * metric that counts "repeats" differently from the clusterer that acts on them is
 * worse than either alone.
 *
 * THE FUNCTION IS THE VERSION. `ERROR_SIGNATURE_VERSION` is stored on every metric
 * row as `normalization_version` precisely so a change to how signatures are formed
 * is visible as a discontinuity in the series. That only works if the version
 * number and the function move together: change the bucketing, bump the constant,
 * in the same commit. They are one definition with two faces.
 */
import { createHash } from 'node:crypto'

/** Bump IN THE SAME COMMIT as any change to `errorSignature`. Stored on metric rows. */
export const ERROR_SIGNATURE_VERSION = 1

/** lowercase, collapse internal whitespace, trim. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v
  return ''
}

/** First non-empty line of a string value, or '' - used to reduce a free-text
 *  message to a coarse class without the whole body. */
function firstLine(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.split(/\r?\n/)[0] ?? ''
}

/**
 * The signature of an error event's `detail`, or null when there is nothing to
 * bucket on.
 *
 * A `what` component (an error code, an error class, or the first line of a
 * message) and a `where` component (a named area or file) are normalized and
 * hashed together. Null - not an empty-string signature - when neither component is
 * present: an event with no identifying detail must not be counted as a repeat of
 * another equally-empty one, or "no detail" becomes its own busy false signal. A
 * null-signature event still counts in the repeat_error DENOMINATOR (it is an error
 * that happened) but can never be a numerator match.
 *
 * `detail` is agent-supplied free JSON, so this reads only the fields it names and
 * ignores the rest.
 */
export function errorSignature(detail: Record<string, unknown> | null | undefined): string | null {
  const d = detail ?? {}
  const what = normalize(firstString(d.code, d.errorClass, firstLine(d.message)))
  const where = normalize(firstString(d.area, d.file))
  if (what === '' && where === '') return null
  return createHash('sha256').update(`${what}\n${where}`).digest('hex')
}
