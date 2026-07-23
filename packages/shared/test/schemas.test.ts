import { describe, expect, it } from 'vitest'
import { ackInput, closeInput, eventInput, projectAccessLevel, replyInput, sendMessageInput } from '../src/index'

describe('sendMessageInput', () => {
  it('accepts a valid payload', () => {
    const parsed = sendMessageInput.parse({
      project: 'demo-project',
      from: 'web',
      to: ['android'],
      subject: 'docent offline strategy',
      body: 'API 스펙 협의가 필요합니다.',
    })
    expect(parsed.to).toEqual(['android'])
  })

  it('rejects empty recipients', () => {
    expect(() =>
      sendMessageInput.parse({ project: 'p', from: 'web', to: [], subject: 's', body: 'b' }),
    ).toThrow()
  })
})

describe('other inputs', () => {
  it('replyInput requires body', () => {
    expect(() => replyInput.parse({ project: 'p', from: 'web', body: '' })).toThrow()
  })
  it('ackInput requires part', () => {
    expect(ackInput.parse({ project: 'p', part: 'android' }).part).toBe('android')
  })
  it('closeInput rejects open', () => {
    expect(() => closeInput.parse({ project: 'p', status: 'open' })).toThrow()
    expect(closeInput.parse({ project: 'p', status: 'answered' }).status).toBe('answered')
  })
  it('eventInput defaults detail to empty object', () => {
    const e = eventInput.parse({ project: 'p', part: 'web', type: 'spawn' })
    expect(e.detail).toEqual({})
  })
})

describe('projectAccessLevel', () => {
  it('accepts owner, which the member-management guards depend on', () => {
    // canManage, the owner count and the last-owner guards in the dashboard all key
    // off this value; an enum without it would reject a grant the product issues.
    expect(projectAccessLevel.parse('owner')).toBe('owner')
  })

  it('accepts the other two grants the dashboard issues', () => {
    expect(projectAccessLevel.parse('readonly')).toBe('readonly')
    expect(projectAccessLevel.parse('write')).toBe('write')
  })

  it('rejects readonly_all, which no code path ever wrote', () => {
    expect(() => projectAccessLevel.parse('readonly_all')).toThrow()
  })
})
