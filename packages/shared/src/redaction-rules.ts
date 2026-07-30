/**
 * Redaction rules: what a project can configure, and how it becomes a regex.
 *
 * THE BOUNDARY THIS FILE EXISTS TO BE. Redaction patterns used to be a bare
 * `string[]` that the server handed straight to `new RegExp`, and the safety argument
 * was "the settings UI will only ever write escaped literals and our own detectors".
 * That is a promise made in another package, not a property of the data: one more
 * writer to that column - a script, a psql session, a second UI - and the argument is
 * gone. Review loop 7 refused it on exactly those grounds.
 *
 * So the stored shape is a discriminated union and **no operator-authored regex is
 * ever compiled**. A literal is escaped here; a detector is ours, resolved by id.
 * The rule is now something the data enforces rather than something a team remembers.
 *
 * This lives in `shared` because both sides need the same answer: the server resolves
 * ids to patterns at write time, and the dashboard resolves them to tell an owner what
 * their configuration currently does. A second copy of the catalogue would be a second
 * set of rules, which is the defect class this project spent a release removing.
 */

/** A literal the owner typed. Stored verbatim; escaped at resolution. */
export interface LiteralRule {
  kind: 'literal'
  value: string
}

/**
 * One of our detectors, pinned to the version the owner saved.
 *
 * The version is per detector, not per catalogue: a catalogue-wide version would mark
 * every project stale whenever any single detector changed, which makes "a newer
 * version exists" useless as a signal.
 */
export interface DetectorRule {
  kind: 'detector'
  id: string
  v: number
}

export type RedactionRule = LiteralRule | DetectorRule

/**
 * Why a configured rule could not be turned into a pattern.
 *
 * `legacy_patterns` is the old `redactionPatterns` key. It never had a write path, so
 * no project can have one through the product - but "no code writes it" is not "no row
 * has it", and a configuration that silently stops being applied is the failure this
 * whole file exists to prevent. If it turns up, it is unresolved like anything else.
 */
export interface UnresolvedRule {
  reason:
    | 'unknown_detector'
    | 'unknown_version'
    | 'literal_too_short'
    | 'literal_too_long'
    | 'legacy_patterns'
    /** The stored value is not a rule this code understands - wrong `kind`, wrong types,
     *  not an object, or not an array. The column is JSONB and TypeScript does not reach
     *  into it, so this is the case that exists because the type is a claim about what
     *  SHOULD be there rather than a check of what IS. */
    | 'malformed_rule'
    /** More rules than the bound allows. */
    | 'too_many_rules'
    /** OUR OWN catalogue entry does not compile, or matches the empty string. Reported
     *  rather than skipped because a detector that cannot run is a protection the owner
     *  switched on and we are not applying - the same reason every other entry here
     *  exists, except that this one is our bug rather than their configuration. */
    | 'broken_detector'
  detail: string
}

export interface ResolvedRedaction {
  /** Ready to compile. Literals already escaped. */
  patterns: string[]
  /**
   * Non-empty means **do not write**. Not "log and continue": a rule that cannot be
   * resolved is a protection the owner switched on and the system is not applying, and
   * reporting it while storing the row anyway is observation rather than protection.
   * The knowledge invariant forbids the storage, not the silence.
   */
  unresolved: UnresolvedRule[]
}

/** Maximum rules per project. A bound on configuration mistakes, not on attackers -
 *  operator regexes cannot reach the engine at all. */
export const MAX_REDACTION_RULES = 50

/**
 * Minimum literal length, and the reason it is not cosmetic: redaction DROPS the
 * matched span rather than masking it, so a one-character literal deletes that
 * character from every body this project ever stores, irreversibly. A short literal is
 * not a weak filter, it is a destructive one.
 */
export const MIN_LITERAL_LENGTH = 4
export const MAX_LITERAL_LENGTH = 200

/** Whether a pattern compiles and would remove a real span. Mirrors `redact`'s two runtime
 *  skips so that a pattern reaching it can always run. */
function isUsablePattern(pattern: string): boolean {
  try {
    return !new RegExp(pattern, 'g').test('')
  }
  catch {
    return false
  }
}

/** Escape every regex metacharacter so a literal matches itself and nothing else. */
export function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The detector catalogue: id -> version -> pattern.
 *
 * **Deleting a version that a project still references stops that project's knowledge
 * collection**, because a rule we cannot resolve makes every write fail closed. Count
 * the references in `project.knowledge_config` before removing anything; the count is
 * cheap and the alternative is an owner whose extraction quietly stops.
 *
 * Stated as the consequence rather than as a rule on purpose. A rule invites a way
 * around it; a consequence invites a second thought.
 *
 * Old versions therefore accumulate, and that is correct - a project pinned to v1 must
 * keep getting v1 until someone re-saves it. Changing a detector means adding a
 * version, never editing one in place: editing in place widens or narrows a
 * destruction rule underneath a project that never asked for the change.
 */
export const DETECTOR_CATALOGUE: Record<string, Record<number, string>> = {
  // Deliberately empty at this commit. Detectors land with the settings UI, each with
  // its own review - a detector is a rule about what gets destroyed, so "add a few
  // obvious ones now" is exactly the shortcut not to take.
}

/**
 * Turn a project's stored configuration into patterns, or into the reasons it cannot be.
 *
 * Callers MUST check `unresolved` before using `patterns`. The shape makes that hard to
 * skip by accident - `patterns` alone is never the whole answer - but the contract is
 * stated here because the cost of ignoring it is a stored secret.
 */
export function resolveRedactionRules(config: {
  // `unknown`, not `RedactionRule[]`, and the weaker type is the honest one: this comes
  // out of a JSONB column, so a caller that has a typed view of it has a claim rather
  // than a guarantee. Declaring the parameter as the union would let a caller's cast
  // stand in for this function's checks, which is the substitution this whole file
  // exists to refuse.
  redactionRules?: unknown
  redactionPatterns?: unknown
} | null | undefined): ResolvedRedaction {
  const patterns: string[] = []
  const unresolved: UnresolvedRule[] = []

  // The ROOT is validated too, for the same reason the members are: this comes out of a
  // JSONB column, so `{}` is what the product writes and a scalar, an array or a JSON null
  // is what a hand-edited row can hold. Treating those as "no configuration" would resolve
  // them cleanly - a project whose settings are unreadable would look like a project with
  // no settings, which is the one reading that must never happen quietly.
  if (config !== null && config !== undefined
    && (typeof config !== 'object' || Array.isArray(config))) {
    return {
      patterns,
      unresolved: [{ reason: 'malformed_rule', detail: 'knowledge_config is not an object' }],
    }
  }

  if (config?.redactionPatterns !== undefined) {
    unresolved.push({
      reason: 'legacy_patterns',
      detail: 'knowledge_config.redactionPatterns is no longer supported; re-save the project\'s redaction settings',
    })
  }

  // EVERYTHING BELOW TREATS THE INPUT AS UNKNOWN, and the parameter type is the reason it
  // has to. `knowledge_config` is JSONB; the TypeScript shape is a claim about what should
  // be in the column, not a check of what is, and the whole point of this file is that a
  // boundary made of claims is not a boundary. A row hand-edited in psql, a writer from a
  // future version, or a bug in the dashboard all arrive here as `any` wearing a type.
  const raw: unknown = config?.redactionRules
  if (raw !== undefined && !Array.isArray(raw)) {
    unresolved.push({ reason: 'malformed_rule', detail: 'redactionRules is not an array' })
    return { patterns, unresolved }
  }
  const rules: unknown[] = Array.isArray(raw) ? raw : []

  // The bound was exported and never read - a limit that exists only in the type is a
  // limit the dashboard advertises and the server does not have.
  if (rules.length > MAX_REDACTION_RULES) {
    unresolved.push({
      reason: 'too_many_rules',
      detail: `${rules.length} rules exceeds the maximum of ${MAX_REDACTION_RULES}`,
    })
    return { patterns, unresolved }
  }

  for (const candidate of rules) {
    if (typeof candidate !== 'object' || candidate === null) {
      unresolved.push({ reason: 'malformed_rule', detail: `not an object: ${JSON.stringify(candidate)}` })
      continue
    }
    const rule = candidate as Partial<LiteralRule> & Partial<DetectorRule> & { kind?: unknown }
    if (rule.kind !== 'literal' && rule.kind !== 'detector') {
      unresolved.push({ reason: 'malformed_rule', detail: `unknown kind: ${JSON.stringify(rule.kind)}` })
      continue
    }
    if (rule.kind === 'literal' && typeof rule.value !== 'string') {
      unresolved.push({ reason: 'malformed_rule', detail: 'literal rule without a string value' })
      continue
    }
    if (rule.kind === 'detector' && (typeof rule.id !== 'string' || typeof rule.v !== 'number')) {
      unresolved.push({ reason: 'malformed_rule', detail: 'detector rule without a string id and numeric version' })
      continue
    }

    if (rule.kind === 'literal') {
      if (rule.value!.length < MIN_LITERAL_LENGTH) {
        unresolved.push({ reason: 'literal_too_short', detail: `literal shorter than ${MIN_LITERAL_LENGTH} characters` })
        continue
      }
      if (rule.value!.length > MAX_LITERAL_LENGTH) {
        unresolved.push({ reason: 'literal_too_long', detail: `literal longer than ${MAX_LITERAL_LENGTH} characters` })
        continue
      }
      patterns.push(escapeLiteral(rule.value!))
      continue
    }

    const versions = DETECTOR_CATALOGUE[rule.id!]
    if (!versions) {
      unresolved.push({ reason: 'unknown_detector', detail: rule.id! })
      continue
    }
    const pattern = versions[rule.v!]
    if (pattern === undefined) {
      unresolved.push({ reason: 'unknown_version', detail: `${rule.id} v${rule.v}` })
      continue
    }
    // OUR catalogue entry, checked before it is handed on. `redact` skips a pattern that
    // does not compile or that matches the empty string, and that skip is documented as
    // evidence that someone is writing raw patterns - which would be false if our own
    // catalogue could produce one. Checking here keeps that claim true and turns a broken
    // catalogue entry into a refused write instead of a silently absent protection.
    if (!isUsablePattern(pattern)) {
      unresolved.push({ reason: 'broken_detector', detail: `${rule.id} v${rule.v} does not compile or matches empty` })
      continue
    }
    patterns.push(pattern)
  }

  return { patterns, unresolved }
}
