/**
 * The exact SQL expression that snapshots a project's redaction inputs, and the one
 * place it is written.
 *
 * IN `shared`, AND THAT PLACEMENT IS THE POINT. It lived in `apps/server` for one round,
 * during which `packages/db` grew a writer that needed it, could not import it, and hand-
 * copied the expression - which then did not receive the fix that widened it. Review loop 13
 * found the copy stale. **The same placement mistake as `redact()`, one file over and one
 * round later**: a rule kept where its current callers are is a rule the next caller cannot
 * reach.
 *
 * WHY IT IS A SHARED CONSTANT AND NOT COPIED: two writers compare a snapshot they took
 * earlier against the current value, and the comparison is only sound if both sides
 * describe the SAME inputs. Review loop 11 found the first version of this comparing
 * `redactionRules` alone while the resolver ALSO treats a stored `redactionPatterns` key
 * as decisive - so adding that key concurrently passed the guard and changed the answer.
 * A second copy of the expression is a second definition of "the inputs", and the whole
 * class of defect this release keeps finding is two definitions of one thing.
 *
 * It covers every key `resolveRedactionRules` reads. **Adding a key to the resolver means
 * adding it here**, and `packages/db/test/redaction-snapshot-coverage.test.ts` is what makes
 * that instruction more than a hope: it asserts that no two configurations resolving
 * DIFFERENTLY snapshot IDENTICALLY. Loop 13 found this comment claiming such a test existed
 * when it did not - the claim came first and the test second, which is the wrong order and
 * is why the gap it describes was live.
 */
export const REDACTION_INPUT_SNAPSHOT = redactionInputSnapshot('knowledge_config')

/** The same expression, aliased to a table the caller has joined as `p`. */
export const REDACTION_INPUT_SNAPSHOT_P = redactionInputSnapshot('p.knowledge_config')

/**
 * Everything `resolveRedactionRules` looks at, and the two members that are easy to leave
 * out are the ones review loop 12 found missing: the resolver branches on **the type of
 * the root** and on **whether a key is present**, not only on the values. Snapshotting
 * `-> key` alone made `{}`, a scalar root, `{redactionRules: null}` and
 * `{redactionPatterns: null}` all look identical, so a configuration could become malformed
 * - which the resolver refuses - while the guard saw no change at all.
 *
 * The general form: **a comparison is only as good as its coverage of the decision's
 * inputs**, and "the value the function reads" is not the same set as "what the function
 * decides on".
 */
function redactionInputSnapshot(col: string): string {
  return `jsonb_build_object(
  'root', jsonb_typeof(${col}),
  'has_rules', ${col} ? 'redactionRules',
  'rules', ${col} -> 'redactionRules',
  'has_legacy', ${col} ? 'redactionPatterns',
  'legacy', ${col} -> 'redactionPatterns'
)::text`
}

