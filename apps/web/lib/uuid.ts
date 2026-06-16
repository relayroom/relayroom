const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True if `s` is a well-formed UUID. Used to reject malformed IDs from client
 * input BEFORE they reach a `uuid` column, where Postgres would otherwise raise
 * "invalid input syntax for type uuid" (a 500-ish error) instead of a clean
 * not-found. A malformed id is treated as not-found by callers.
 */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
