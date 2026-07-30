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
  /**
   * Patterns that did NOT run, and why. Empty on the ordinary path.
   *
   * THE HAZARD this exists for: a skipped pattern is a secret that reaches the table
   * while the owner believes it cannot. Skipping is still the right runtime behaviour -
   * one malformed regex must not break every write for the project - but doing it
   * silently makes a configuration error indistinguishable from a working denylist, and
   * the only person who could notice is the one who cannot see it. Callers are expected
   * to surface this; the pattern text is safe to log because it is the owner's own
   * config, unlike the text it would have matched.
   */
  skipped: SkippedPattern[]
}

export interface SkippedPattern {
  /** The configured pattern, verbatim. Owner-authored config, not user content. */
  pattern: string
  /**
   * `invalid`: not a compilable regex. `matches_empty`: compiles, but matches the empty
   * string, which applied globally removes nothing while matching everywhere.
   */
  reason: 'invalid' | 'matches_empty'
}

/** Compile a pattern string to a global RegExp, or null if it is invalid. */
function compile(pattern: string): RegExp | null {
  try {
    // Global so every occurrence is removed, not just the first.
    //
    // On where these strings come from: this comment used to say "project config
    // (manager-set)", which was wrong twice over. No project has ever set one - the
    // key has no write path, so every call to date has passed an empty list - and when
    // a write path arrives the gate is the OWNER, not a manager. Both halves were
    // written from an assumption about how the feature would work rather than from a
    // writer, which is why neither aged into being true.
    //
    // What is durable, and the reason to skip rather than throw: whoever ends up
    // authoring these, they are configuration and not agent input, so a bad string is a
    // configuration error. Failing the write would let one malformed pattern take down
    // every knowledge write for that project. The skip is reported instead - see
    // RedactionResult.skipped.
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
    if (!re || re.test('')) continue // reported by skippedPatterns, not decided here
    out = out.replace(re, () => {
      redactions++
      return ''
    })
  }
  return { text: out, redactions, skipped: skippedPatterns(patterns) }
}

/**
 * Which patterns will not run, and why. **Depends only on the patterns, never on the
 * text** - which is what makes it reportable per project rather than per message: a
 * denylist that is broken is broken for every write, so logging it once per sweep says
 * the same thing as logging it per row, without the volume.
 */
export function skippedPatterns(patterns: readonly string[]): SkippedPattern[] {
  const out: SkippedPattern[] = []
  for (const pattern of patterns) {
    const re = compile(pattern)
    if (!re) out.push({ pattern, reason: 'invalid' })
    else if (re.test('')) out.push({ pattern, reason: 'matches_empty' })
  }
  return out
}

/**
 * Log every pattern that did not run, once per write path.
 *
 * Deliberately a log and not an error: refusing the write would let one malformed
 * pattern block every knowledge write for the project, which is the failure the skip
 * exists to avoid. What must not continue is the SILENCE - a configuration error that
 * produces no output is indistinguishable from a denylist that works, and the difference
 * is whether a secret reaches the table.
 *
 * Prints the pattern, never the text. The pattern is owner-authored configuration; the
 * text is the thing the denylist exists to keep out of durable places, and a log is a
 * durable place.
 */
export function reportSkippedPatterns(
  projectId: string,
  path: 'learn' | 'extractor',
  skipped: readonly SkippedPattern[],
): void {
  if (skipped.length === 0) return
  for (const s of skipped) {
    console.warn(
      `[knowledge] redaction pattern skipped (${s.reason}) on ${path} write for project ${projectId}: ${s.pattern}`,
    )
  }
}

/** Whether applying the denylist to `text` would drop anything. */
export function hasRedaction(text: string, patterns: readonly string[]): boolean {
  return redact(text, patterns).redactions > 0
}
