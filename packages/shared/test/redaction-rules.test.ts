/**
 * The boundary these tests defend: no operator-authored regex is ever compiled, and a
 * rule we cannot resolve stops the write rather than being skipped.
 *
 * The escaping test is rrc-web's, carried over from the shelved (C) branch with its
 * shape intact - every metacharacter in one string, asserting the escaped form matches
 * itself. Drop one character from the escape list and it goes red, which is the only
 * property that matters for an escape function.
 */
import { describe, expect, it } from 'vitest'
import {
  DETECTOR_CATALOGUE,
  escapeLiteral,
  MAX_LITERAL_LENGTH,
  MAX_REDACTION_RULES,
  MIN_LITERAL_LENGTH,
  resolveRedactionRules,
} from '../src/redaction-rules'

describe('escapeLiteral', () => {
  it('escapes every metacharacter so a literal matches itself', () => {
    const escaped = escapeLiteral('.*+?^${}()|[]\\')
    expect(new RegExp(escaped, 'g').test('.*+?^${}()|[]\\')).toBe(true)
  })

  it('makes a would-be pattern inert', () => {
    // The whole point: what an owner types is text, not syntax. Without escaping this
    // would match any three characters; with it, only the literal itself.
    const escaped = escapeLiteral('a.c')
    expect(new RegExp(escaped).test('abc')).toBe(false)
    expect(new RegExp(escaped).test('a.c')).toBe(true)
  })
})

describe('resolveRedactionRules', () => {
  it('resolves literals to escaped patterns', () => {
    const r = resolveRedactionRules({ redactionRules: [{ kind: 'literal', value: 'ACME-TOKEN' }] })
    expect(r.unresolved).toEqual([])
    expect(r.patterns).toEqual(['ACME-TOKEN']) // '-' is not a metacharacter outside a class
  })

  it('treats an unknown detector as unresolved rather than as nothing', () => {
    const r = resolveRedactionRules({ redactionRules: [{ kind: 'detector', id: 'nope', v: 1 }] })
    expect(r.patterns).toEqual([])
    expect(r.unresolved).toEqual([{ reason: 'unknown_detector', detail: 'nope' }])
  })

  it('treats a missing VERSION of a known detector as unresolved', () => {
    // The case that arrives when someone tidies the catalogue: the detector still
    // exists, the version a project pinned does not. Silently applying a different
    // version would change what gets destroyed under a project that never asked.
    DETECTOR_CATALOGUE['test-detector'] = { 1: 'AAA-\\d+' }
    try {
      const ok = resolveRedactionRules({ redactionRules: [{ kind: 'detector', id: 'test-detector', v: 1 }] })
      expect(ok.unresolved).toEqual([])
      expect(ok.patterns).toEqual(['AAA-\\d+'])

      const stale = resolveRedactionRules({ redactionRules: [{ kind: 'detector', id: 'test-detector', v: 2 }] })
      expect(stale.patterns).toEqual([])
      expect(stale.unresolved).toEqual([{ reason: 'unknown_version', detail: 'test-detector v2' }])
    }
    finally {
      delete DETECTOR_CATALOGUE['test-detector']
    }
  })

  it('reports the legacy key instead of ignoring it', () => {
    // `redactionPatterns` never had a write path, so no project can hold one through
    // the product - but "no code writes it" is not "no row has it", and a protection
    // that stops being applied without saying so is the failure this shape prevents.
    const r = resolveRedactionRules({ redactionPatterns: ['sk-[a-z]+'] })
    expect(r.patterns).toEqual([])
    expect(r.unresolved.map(u => u.reason)).toEqual(['legacy_patterns'])
  })

  it('refuses a literal short enough to be destructive', () => {
    // Redaction DROPS the match, so a one-character literal deletes that character
    // from every body the project stores, irreversibly. The floor is not cosmetic.
    const r = resolveRedactionRules({ redactionRules: [{ kind: 'literal', value: 'a' }] })
    expect(r.patterns).toEqual([])
    expect(r.unresolved.map(u => u.reason)).toEqual(['literal_too_short'])
    expect(MIN_LITERAL_LENGTH).toBeGreaterThan(1)
  })

  it('refuses an over-long literal', () => {
    const r = resolveRedactionRules({ redactionRules: [{ kind: 'literal', value: 'x'.repeat(MAX_LITERAL_LENGTH + 1) }] })
    expect(r.unresolved.map(u => u.reason)).toEqual(['literal_too_long'])
  })

  it('resolves the good rules and still reports the bad one', () => {
    // Deliberately NOT all-or-nothing inside the resolver: the caller decides, and it
    // decides by checking `unresolved`. Returning partial patterns with an empty
    // `unresolved` would be the silent-skip failure wearing a different hat.
    const r = resolveRedactionRules({
      redactionRules: [{ kind: 'literal', value: 'GOOD-LITERAL' }, { kind: 'detector', id: 'gone', v: 3 }],
    })
    expect(r.patterns).toEqual(['GOOD-LITERAL'])
    expect(r.unresolved).toHaveLength(1)
  })

  it('is empty and clean for a project that configured nothing', () => {
    // Every project today. If this ever returned an unresolved entry, redaction would
    // fail closed everywhere - the guard has to be inert by default.
    expect(resolveRedactionRules(undefined)).toEqual({ patterns: [], unresolved: [] })
    expect(resolveRedactionRules({})).toEqual({ patterns: [], unresolved: [] })
    expect(resolveRedactionRules({ redactionRules: [] })).toEqual({ patterns: [], unresolved: [] })
  })
})

/**
 * The resolver is a RUNTIME boundary, not a typed one.
 *
 * Review loop 10 found that the previous version trusted its parameter type: the column
 * is JSONB, the TypeScript shape is a claim about what should be in it, and a hand-edited
 * row or a future writer arrives as `any` wearing a type. Several shapes threw instead of
 * resolving, unknown `kind` values were treated as detectors, and the rule-count bound was
 * exported and never read - a limit the dashboard advertised and the server did not have.
 *
 * Every case below must produce `unresolved`, never a throw and never a silent pass,
 * because both of those end with a write happening under a rule that was not applied.
 */
describe('resolveRedactionRules as a runtime boundary', () => {
  const bad: [string, unknown][] = [
    ['not an array', { redactionRules: {} }],
    ['a scalar member', { redactionRules: [42] }],
    ['a null member', { redactionRules: [null] }],
    ['an unknown kind', { redactionRules: [{ kind: 'regex', value: '.*' }] }],
    ['a literal with a non-string value', { redactionRules: [{ kind: 'literal', value: 7 }] }],
    ['a detector with a string version', { redactionRules: [{ kind: 'detector', id: 'x', v: '1' }] }],
    ['a detector with no id', { redactionRules: [{ kind: 'detector', v: 1 }] }],
  ]

  for (const [name, config] of bad) {
    it(`reports ${name} instead of throwing or ignoring it`, () => {
      const r = resolveRedactionRules(config as never)
      expect(r.patterns).toEqual([])
      expect(r.unresolved.length).toBeGreaterThan(0)
    })
  }

  it('enforces the rule-count bound instead of only exporting it', () => {
    const many = Array.from({ length: MAX_REDACTION_RULES + 1 }, (_, i) => ({
      kind: 'literal' as const, value: `LITERAL-${i}`,
    }))
    const r = resolveRedactionRules({ redactionRules: many })
    expect(r.patterns).toEqual([])
    expect(r.unresolved.map(u => u.reason)).toEqual(['too_many_rules'])

    // And the bound is not off by one in the other direction - the limit is usable.
    const exact = many.slice(0, MAX_REDACTION_RULES)
    expect(resolveRedactionRules({ redactionRules: exact }).unresolved).toEqual([])
  })

  it('refuses OUR OWN broken catalogue entry rather than letting redact skip it', () => {
    // `redact` skips a pattern that does not compile or matches the empty string, and
    // that skip is documented as evidence that someone is writing raw patterns. If our
    // catalogue could produce one, that claim would be false and a detector the owner
    // switched on would silently not run.
    DETECTOR_CATALOGUE['broken-a'] = { 1: '(unclosed' }
    DETECTOR_CATALOGUE['broken-b'] = { 1: 'x*' }
    try {
      expect(resolveRedactionRules({ redactionRules: [{ kind: 'detector', id: 'broken-a', v: 1 }] })
        .unresolved.map(u => u.reason)).toEqual(['broken_detector'])
      expect(resolveRedactionRules({ redactionRules: [{ kind: 'detector', id: 'broken-b', v: 1 }] })
        .unresolved.map(u => u.reason)).toEqual(['broken_detector'])
    }
    finally {
      delete DETECTOR_CATALOGUE['broken-a']
      delete DETECTOR_CATALOGUE['broken-b']
    }
  })
})

/**
 * The two shapes loop 12 found slipping through, kept as their own block because both are
 * cases where a check existed and did not cover what it claimed.
 */
describe('resolveRedactionRules - root and counting', () => {
  it('treats a JSON null root as malformed, not as an absent configuration', () => {
    // knowledge_config is NOT NULL, so a null here means the column holds JSON null - a
    // configuration that cannot be read, which must not look like a project that has none.
    // `undefined` stays clean: that is "no row", not "unreadable row".
    expect(resolveRedactionRules(null).unresolved.map(u => u.reason)).toEqual(['malformed_rule'])
    expect(resolveRedactionRules(undefined)).toEqual({ patterns: [], unresolved: [] })
  })

  it('rejects a scalar or array root', () => {
    expect(resolveRedactionRules('nope' as never).unresolved).toHaveLength(1)
    expect(resolveRedactionRules([] as never).unresolved).toHaveLength(1)
  })

  it('counts code points, so a pair of emoji does not clear the four-character floor', () => {
    // `.length` would say 4 for two astral characters. The floor exists because a short
    // literal deletes its text from every body the project stores; a minimum that two
    // emoji satisfy is not a minimum.
    const r = resolveRedactionRules({ redactionRules: [{ kind: 'literal', value: '😀😀' }] })
    expect(r.unresolved.map(u => u.reason)).toEqual(['literal_too_short'])
    // And four real characters still pass, so the fix did not just move the bar.
    expect(resolveRedactionRules({ redactionRules: [{ kind: 'literal', value: '가나다라' }] }).unresolved)
      .toEqual([])
  })
})
