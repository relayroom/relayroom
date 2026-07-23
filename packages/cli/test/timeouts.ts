/**
 * The two time budgets these tests run under, in one place because they only mean
 * anything relative to each other.
 *
 * Several tests spawn a real process (bash running the generated rr.sh, node
 * running the pager) and pass `timeout: SUBPROCESS_TIMEOUT_MS` so a genuinely
 * hung child is killed with a diagnosis instead of hanging the run. That guard
 * only fires if vitest is still waiting when it does. vitest's default is 5s, so
 * for a long time the 20s written into the tests was fiction: vitest always got
 * there first, and the declared intent had no effect on anything.
 *
 * So the test timeout is deliberately LARGER, not equal. Equal is a race, and a
 * race resolves as vitest's generic "Test timed out in 20000ms" instead of the
 * child's own error - losing exactly the information the guard exists to give.
 */

/** How long a spawned child may run before the test kills it. */
export const SUBPROCESS_TIMEOUT_MS = 20_000

/** vitest's per-test budget. Must stay above the child budget; a test asserts it. */
export const TEST_TIMEOUT_MS = 30_000
