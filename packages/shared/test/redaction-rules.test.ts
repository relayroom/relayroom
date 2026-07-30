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
