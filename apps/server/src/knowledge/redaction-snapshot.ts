/**
 * The exact SQL expression that snapshots a project's redaction inputs, and the one
 * place it is written.
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
 * adding it here**, and the test that pins the two together is the reason that instruction
 * is not just a hope.
 */
export const REDACTION_INPUT_SNAPSHOT = `jsonb_build_object(
  'rules', knowledge_config -> 'redactionRules',
  'legacy', knowledge_config -> 'redactionPatterns'
)::text`

/** The same expression, aliased to a table the caller has joined as `p`. */
export const REDACTION_INPUT_SNAPSHOT_P = `jsonb_build_object(
  'rules', p.knowledge_config -> 'redactionRules',
  'legacy', p.knowledge_config -> 'redactionPatterns'
)::text`
