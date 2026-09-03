/**
 * The heartbeat carries what the pager ASKED FOR and what it actually FOUND.
 *
 * Before this, the measured mode reached only the pager's local log: the hub knew a
 * pager was alive and nothing about how it was delivering. A part configured for herdr
 * whose socket was unreachable falls back to tmux and keeps delivering - wakes arrive,
 * but not the way the worktree asked - and from the hub that was byte-identical to a
 * healthy tmux part.
 *
 * The two columns are separate on purpose: the state worth seeing is the DISAGREEMENT,
 * and one field cannot hold one. The tests below are mostly about what must NOT be
 * written, because every wrong answer here is a confident one.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agents, projects } from '@relayroom/db'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const ORG = `hm-org-${randomBytes(4).toString('hex')}`
const USER = `hm-user-${randomBytes(4).toString('hex')}`

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER}, 'HM User', ${USER + '@hm.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'HM Org', NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'hm-mem-' + randomBytes(4).toString('hex')}, ${ORG}, ${USER}, 'member', NOW())`
})

async function scene() {
  const sfx = randomBytes(6).toString('hex')
  const connectCode = `hm-cc-${sfx}`
  const [p] = await db.insert(projects).values({
    organizationId: ORG, slug: `hm-${sfx}`, name: 'HM Project', connectCode,
  }).returning({ id: projects.id })
  const [a] = await db.insert(agents)
    .values({ projectId: p!.id, part: 'core', ownerUserId: USER }).returning({ id: agents.id })
  return { connectCode, agentId: a!.id }
}

/** The heartbeat exactly as the pager sends it, minus whatever the case omits. */
const beat = (connectCode: string, body: Record<string, unknown>) =>
  app.request(`/mcp/${connectCode}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ part: 'core', holder: 'h1', ...body }),
  })

const stored = async (agentId: string) => {
  const [row] = await db
    .select({ intent: agents.multiplexerIntent, active: agents.multiplexerActive })
    .from(agents).where(eq(agents.id, agentId)).limit(1)
  return row
}

describe('heartbeat: measured multiplexer', () => {
  it('records intent and measured mode separately', async () => {
    const s = await scene()
    expect((await beat(s.connectCode, { multiplexer: { intent: 'herdr', active: 'herdr' } })).status).toBe(200)
    expect(await stored(s.agentId)).toEqual({ intent: 'herdr', active: 'herdr' })
  })

  it('keeps a disagreement representable - herdr asked for, tmux delivering', async () => {
    const s = await scene()
    await beat(s.connectCode, { multiplexer: { intent: 'herdr', active: 'tmux' } })
    // The whole reason there are two columns. Collapsing them into one would make this
    // state either invisible (report the intent) or a lie (report the fallback as the
    // configuration).
    expect(await stored(s.agentId)).toEqual({ intent: 'herdr', active: 'tmux' })
  })

  it('a pager that does not report leaves NULL, not tmux', async () => {
    const s = await scene()
    // Every pager on the previous release sends no `multiplexer` at all. A default here
    // would invent a measurement for every existing part, and the dashboard would draw a
    // confident tmux badge for parts nobody has asked.
    expect((await beat(s.connectCode, {})).status).toBe(200)
    expect(await stored(s.agentId)).toEqual({ intent: null, active: null })
  })

  it('does not let a later silent beat erase what was measured', async () => {
    const s = await scene()
    await beat(s.connectCode, { multiplexer: { intent: 'herdr', active: 'herdr' } })
    await beat(s.connectCode, {})
    // Absent means "not reported on this beat", never "reset it". A pager restarted with
    // an older CLI must not wipe the field to null and make the part look unmeasured.
    expect(await stored(s.agentId)).toEqual({ intent: 'herdr', active: 'herdr' })
  })

  it('drops values it cannot render instead of storing them', async () => {
    const s = await scene()
    await beat(s.connectCode, { multiplexer: { intent: 'screen', active: { nested: true } } })
    expect(await stored(s.agentId)).toEqual({ intent: null, active: null })
    // And a half-valid payload stores only the half it understands.
    await beat(s.connectCode, { multiplexer: { intent: 'tmux', active: 'zellij' } })
    expect(await stored(s.agentId)).toEqual({ intent: 'tmux', active: null })
  })

  it('still records liveness when the multiplexer payload is junk', async () => {
    const s = await scene()
    const before = new Date()
    expect((await beat(s.connectCode, { multiplexer: 'herdr' })).status).toBe(200)
    const [row] = await db
      .select({ seen: agents.pagerLastSeenAt }).from(agents).where(eq(agents.id, s.agentId)).limit(1)
    // A status field must never be able to cost the part its liveness signal.
    expect(row!.seen!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
  })
})
