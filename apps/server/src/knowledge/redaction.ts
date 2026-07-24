/**
 * Redaction denylist for knowledge writes (FEAT-0004 L3).
 *
 * A project configures regexes for secrets and PII; any span they match is DROPPED
 * from the text before it is stored - removed, not masked. Design 02 is explicit:
 * "a matched span is dropped, not stored." Masking (replacing with ****) would still
 * record the shape and position of the secret and, worse, imply the redaction was
 * lossless when the point is that the sensitive bytes never touch the table.
 *
 * Applied by BOTH the extractor and the `learn` tool before any row is written -
 * the extractor because it reads raw thread text, `learn` because a human pasting a
 * lesson can paste a secret with it. A denylist on only one of the two write paths
 * is a denylist with a hole.
 *
 * Pure and config-driven: the patterns come from the project's knowledgeConfig; this
 * only applies them. Invalid patterns are skipped, not thrown - one malformed regex
 * in a project's config must not take down every write for that project.
 */

export interface RedactionResult {
  /** The text with every matched span removed. */
  text: string
  /** How many spans were dropped. Lets a caller log that redaction fired without
   *  logging WHAT it dropped - the whole point is that the secret does not persist. */
  redactions: number
}

/** Compile a pattern string to a global RegExp, or null if it is invalid. */
function compile(pattern: string): RegExp | null {
  try {
    // Global so every occurrence is removed, not just the first. The source is
    // project config (manager-set), not agent input, but a bad string is still a
    // config error to skip rather than a crash.
    return new RegExp(pattern, 'g')
  }
  catch {
    return null
  }
}

/**
 * Drop every span matching any denylist pattern from `text`.
 *
 * Patterns are applied in order; each removes all of its matches from what the
 * previous ones left. An empty pattern list returns the text unchanged with zero
 * redactions - a project that configured no denylist redacts nothing.
 *
 * A pattern that can match the empty string is skipped: applied globally it would
 * "match" between every character and either loop or corrupt the text without
 * removing anything meaningful.
 */
export function redact(text: string, patterns: readonly string[]): RedactionResult {
  let out = text
  let redactions = 0
  for (const pattern of patterns) {
    const re = compile(pattern)
    if (!re) continue
    if (re.test('')) continue // matches empty -> would not remove a real span
    out = out.replace(re, () => {
      redactions++
      return ''
    })
  }
  return { text: out, redactions }
}

/** Whether applying the denylist to `text` would drop anything. */
export function hasRedaction(text: string, patterns: readonly string[]): boolean {
  return redact(text, patterns).redactions > 0
}
