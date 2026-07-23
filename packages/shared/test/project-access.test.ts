import { describe, expect, it } from 'vitest'
import { projectAccessLevel, type ProjectAccessLevel } from '../src/index'
import {
  PROJECT_ACCESS_RANK,
  decideProjectAccess,
  effectiveProjectLevel,
  isOrgManager,
  meetsProjectAccess,
} from '../src/project-access'

/**
 * Every case here is a way authority could be granted or withheld wrongly. The
 * ones that matter most are the two a plain rank comparison gets wrong: an org
 * owner with no grant row (locked out of their own org), and a banned org owner
 * (whose role would otherwise hand them everything).
 */
describe('project access decision', () => {
  it('keeps the rank table and the level enum in sync', () => {
    // The rank keys are the runtime domain: a level added to the enum but not
    // here would rank as undefined and compare false against everything.
    expect(Object.keys(PROJECT_ACCESS_RANK).sort()).toEqual([...projectAccessLevel.options].sort())
  })

  it('orders readonly below write below owner', () => {
    expect(PROJECT_ACCESS_RANK.readonly).toBeLessThan(PROJECT_ACCESS_RANK.write)
    expect(PROJECT_ACCESS_RANK.write).toBeLessThan(PROJECT_ACCESS_RANK.owner)
    expect(meetsProjectAccess('write', 'readonly')).toBe(true)
    expect(meetsProjectAccess('write', 'write')).toBe(true)
    expect(meetsProjectAccess('write', 'owner')).toBe(false)
  })

  it('treats org owners and admins as project owners without a grant', () => {
    // Otherwise an org admin is locked out of a project simply because nobody
    // issued them a project_access row in it.
    for (const orgRole of ['owner', 'admin']) {
      expect(isOrgManager(orgRole)).toBe(true)
      expect(decideProjectAccess({ orgRole }, 'owner')).toEqual({ ok: true, level: 'owner' })
    }
  })

  it('does not promote an ordinary member on role alone', () => {
    expect(isOrgManager('member')).toBe(false)
    expect(decideProjectAccess({ orgRole: 'member' }, 'readonly')).toEqual({
      ok: false,
      reason: 'no_grant',
    })
  })

  it('lets an explicit grant stand for a member', () => {
    expect(decideProjectAccess({ orgRole: 'member', grantLevel: 'write' }, 'write'))
      .toEqual({ ok: true, level: 'write' })
    expect(decideProjectAccess({ orgRole: 'member', grantLevel: 'readonly' }, 'write'))
      .toEqual({ ok: false, reason: 'insufficient_level', level: 'readonly' })
  })

  it('never grants a grant an org manager would outrank', () => {
    // A manager keeps owner even when their explicit row says less.
    expect(effectiveProjectLevel({ orgRole: 'admin', grantLevel: 'readonly' })).toBe('owner')
  })

  it('denies a non-member of the project org outright', () => {
    for (const orgRole of [null, undefined, '']) {
      expect(decideProjectAccess({ orgRole }, 'readonly')).toEqual({
        ok: false,
        reason: 'not_org_member',
      })
    }
  })

  it('lets a ban outrank every role and grant', () => {
    // A ban revokes authority no matter where it came from - the org-manager
    // rule included. Both timestamp shapes the callers have.
    const banned = [new Date(), '2026-01-01T00:00:00Z']
    for (const bannedAt of banned) {
      expect(decideProjectAccess({ orgRole: 'owner', bannedAt }, 'readonly'))
        .toEqual({ ok: false, reason: 'banned' })
      expect(decideProjectAccess({ orgRole: 'member', grantLevel: 'owner', bannedAt }, 'readonly'))
        .toEqual({ ok: false, reason: 'banned' })
    }
    // An unbanned row carries a null there, and must not read as banned.
    expect(decideProjectAccess({ orgRole: 'member', grantLevel: 'readonly', bannedAt: null }, 'readonly'))
      .toEqual({ ok: true, level: 'readonly' })
  })

  it('refuses to trust a level outside the enum', () => {
    // project_access.level is plain text. An unknown value is not evidence of
    // authority, and must not be ranked as one.
    for (const grantLevel of ['superuser', 'readonly_all', 'OWNER', '']) {
      expect(effectiveProjectLevel({ orgRole: 'member', grantLevel })).toBeNull()
      expect(decideProjectAccess({ orgRole: 'member', grantLevel }, 'readonly'))
        .toEqual({ ok: false, reason: 'no_grant' })
    }
  })

  it('answers with no context, translation, or database around it', () => {
    // The property that makes this usable from the MCP server: the module is a
    // pure function of its arguments. Freezing the input proves it writes nothing.
    const facts = Object.freeze({ orgRole: 'member', grantLevel: 'write' })
    const first = decideProjectAccess(facts, 'readonly')
    const second = decideProjectAccess(facts, 'readonly')
    expect(first).toEqual(second)
    expect(facts).toEqual({ orgRole: 'member', grantLevel: 'write' })
  })

  it('covers every documented denial reason', () => {
    // A reason the callers cannot produce is a message nobody can write.
    const seen = new Set<string>()
    const cases: { facts: Parameters<typeof decideProjectAccess>[0]; min: ProjectAccessLevel }[] = [
      { facts: {}, min: 'readonly' },
      { facts: { orgRole: 'member', bannedAt: new Date() }, min: 'readonly' },
      { facts: { orgRole: 'member' }, min: 'readonly' },
      { facts: { orgRole: 'member', grantLevel: 'readonly' }, min: 'owner' },
    ]
    for (const c of cases) {
      const result = decideProjectAccess(c.facts, c.min)
      if (!result.ok) seen.add(result.reason)
    }
    expect([...seen].sort()).toEqual(['banned', 'insufficient_level', 'no_grant', 'not_org_member'])
  })
})
