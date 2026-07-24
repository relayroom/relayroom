/**
 * The extraction rule (FEAT-0004 L3 minimal, the swap point). Pure: thread in,
 * candidate out. Pins the L3 rule and, crucially, that redaction happens before a
 * candidate is formed.
 */
import { describe, expect, it } from 'vitest'
import { extractCandidateFromThread, KIND_HEURISTIC } from '../src/knowledge/extract'

const at = (h: number) => new Date(`2026-07-24T0${h}:00:00.000Z`)

describe('extractCandidateFromThread', () => {
  it('titles by subject, bodies by the last agent message, kind by the heuristic', () => {
    const c = extractCandidateFromThread({
      threadId: 't1',
      subject: 'How do we deploy on Fridays',
      messages: [
        { body: 'question', fromAgentId: 'a1', createdAt: at(1) },
        { body: 'we never deploy on Fridays', fromAgentId: 'a2', createdAt: at(2) },
      ],
    }, [])
    expect(c).toEqual({
      title: 'How do we deploy on Fridays',
      body: 'we never deploy on Fridays',
      kind: KIND_HEURISTIC,
      sourceRefs: [{ threadId: 't1' }],
    })
  })

  it('ignores system/human-lane rows when picking the last message', () => {
    const c = extractCandidateFromThread({
      threadId: 't2',
      subject: 's',
      messages: [
        { body: 'the real lesson', fromAgentId: 'a1', createdAt: at(1) },
        { body: 'system close notice', fromAgentId: null, createdAt: at(2) },
      ],
    }, [])
    expect(c!.body).toBe('the real lesson')
  })

  it('returns null when the thread has no agent message', () => {
    const c = extractCandidateFromThread({
      threadId: 't3', subject: 's',
      messages: [{ body: 'only system', fromAgentId: null, createdAt: at(1) }],
    }, [])
    expect(c).toBeNull()
  })

  it('redacts the body BEFORE forming the candidate', () => {
    const c = extractCandidateFromThread({
      threadId: 't4', subject: 'deploy key rotation',
      messages: [{ body: 'the key is sk-abc123 rotate it', fromAgentId: 'a1', createdAt: at(1) }],
    }, ['sk-[a-z0-9]+'])
    expect(c!.body).toBe('the key is  rotate it')
    expect(c!.body).not.toContain('sk-abc123')
  })

  it('produces no candidate when redaction empties the body', () => {
    // A fully-redacted message has no lesson left to keep.
    const c = extractCandidateFromThread({
      threadId: 't5', subject: 's',
      messages: [{ body: 'sk-onlysecret', fromAgentId: 'a1', createdAt: at(1) }],
    }, ['sk-\\w+'])
    expect(c).toBeNull()
  })

  it('falls back to a placeholder title when the subject redacts away, but keeps a real body', () => {
    const c = extractCandidateFromThread({
      threadId: 't6', subject: 'sk-secretsubject',
      messages: [{ body: 'a genuine lesson', fromAgentId: 'a1', createdAt: at(1) }],
    }, ['sk-\\w+'])
    expect(c!.title).toBe('(redacted)')
    expect(c!.body).toBe('a genuine lesson')
  })
})
