/**
 * Reading rows back from a raw `execute()`, the same way on both drivers.
 *
 * THE DEFECT THIS EXISTS TO STOP, because it shipped once and was invisible in this
 * package's own test run. `db.execute()` does not return the same shape everywhere:
 *
 *   postgres-js      (packages/db's own client, apps/server) -> an array of rows
 *   node-postgres    (apps/web's client)                     -> { rows, rowCount }
 *
 * So `const [row] = await tx.execute(...)` works in this package's tests and throws
 * `TypeError: (intermediate value) is not iterable` in the dashboard. `decideProposal`
 * had exactly that, and apps/web is its ONLY production caller - so the function threw
 * everywhere it actually ran, the web action caught it and reported "already decided",
 * and a user saw proposal approval quietly do nothing.
 *
 * The general shape, worth more than this one fix: **this package is consumed by two
 * drivers, and its test suite runs on one of them.** Green here is a statement about
 * half the callers. Anything in `packages/db` that touches driver-specific behaviour has
 * to be either driver-agnostic or exercised on both - see driver-shape.test.ts, which
 * runs the real functions through node-postgres and fails if a raw destructure comes
 * back.
 */

/** Rows from an `execute()` result, whichever driver produced it. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? rows as T[] : []
}

/**
 * The first row, or undefined.
 *
 * Prefer this over `rowsOf(...)[0]` at call sites that want one row: it is the shape
 * that replaces `const [row] = await tx.execute(...)`, so the destructure that caused
 * the bug has a drop-in replacement rather than a rewrite, and reviewers can see at a
 * glance which call sites have been converted.
 */
export function firstRow<T>(result: unknown): T | undefined {
  return rowsOf<T>(result)[0]
}
