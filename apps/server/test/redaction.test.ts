/**
 * Redaction denylist (FEAT-0004 L3). Pure; the drop-not-mask behaviour and the
 * skip-bad-pattern behaviour are pinned here.
 */
import { describe, expect, it } from 'vitest'
import { hasRedaction, redact } from '../src/knowledge/redaction'

describe('redact', () => {
  it('drops a matched span entirely - it does not mask', () => {
    const r = redact('token=sk-abc123 rest', ['sk-[a-z0-9]+'])
    expect(r.text).toBe('token= rest')
    expect(r.text).not.toContain('*')
    expect(r.redactions).toBe(1)
  })

  it('removes every occurrence, not just the first', () => {
    const r = redact('a SECRET b SECRET c', ['SECRET'])
    expect(r.text).toBe('a  b  c')
    expect(r.redactions).toBe(2)
  })

  it('applies multiple patterns in turn', () => {
    const r = redact('email a@b.com key sk-9', ['\\S+@\\S+', 'sk-\\d+'])
    expect(r.text).toBe('email  key ')
    expect(r.redactions).toBe(2)
  })

  it('returns the text unchanged when there are no patterns', () => {
    expect(redact('nothing to hide', [])).toEqual({ text: 'nothing to hide', redactions: 0 })
  })

  it('skips an invalid regex rather than throwing', () => {
    // One broken pattern in a project config must not fail every write.
    const r = redact('keep sk-1', ['(unclosed', 'sk-\\d+'])
    expect(r.text).toBe('keep ')
    expect(r.redactions).toBe(1)
  })

  it('skips a pattern that matches the empty string', () => {
    // Applied globally, an empty-matching pattern would not remove a real span.
    const r = redact('untouched', ['x*'])
    expect(r.text).toBe('untouched')
    expect(r.redactions).toBe(0)
  })

  it('reports whether anything would be dropped without exposing it', () => {
    expect(hasRedaction('has sk-1 inside', ['sk-\\d+'])).toBe(true)
    expect(hasRedaction('clean', ['sk-\\d+'])).toBe(false)
  })
})
