/**
 * A bearer token resolves to the part the caller SAYS it is, not to whichever
 * connection the database returned first.
 *
 * A token is a (user x project) credential and can hold agent_connection rows for
 * several parts at once. That is not an exotic state: re-pointing an agent at a
 * new part while keeping its token leaves the old connection sitting at
 * status='connected', and nothing cleans it up. `validateToken` then did
 * `.limit(1)` with no ORDER BY, so the part it reported was whatever came back
 * first - and the SSE route compared that against the `?part=` the caller sent and
 * refused on mismatch.
 *
 * The result was a pager or channel that could never open its stream. Both send
 * bearer + ?code= + ?part= on every connect, and the token branch wins over the
 * connect-code branch, so a losing coin flip meant a permanent 403. The channel
 * calls catchUp() only after a successful subscribe, so that part received neither
 * live wakes nor catch-up while its messages piled up in the inbox - and its own
 * status stayed green, because the pager heartbeat is a separate path.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentConnections, agents, projects } from '@relayroom/db'
import { INTERNAL_AGENT_CLIENT_ID, projectScope } from '@relayroom/shared'
import postgres from 'postgres'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const ORG = `sp-org-${randomBytes(4).toString('hex')}`
const USER = `sp-user-${randomBytes(4).toString('hex')}`

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('sp-app', 'Internal', ${INTERNAL_AGENT_CLIENT_ID}, NULL,
            'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER}, 'Part User', ${USER + '@sp.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'Part Org', NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'sp-mem-' + randomBytes(4).toString('hex')}, ${ORG}, ${USER}, 'member', NOW())`
})

interface Scene {
  projectId: string
  connectCode: string
  token: string
}

/** A project whose single token holds a connection for each of `parts`. */
async function scene(...parts: string[]): Promise<Scene> {
  const sfx = randomBytes(6).toString('hex')
  const connectCode = `sp-cc-${sfx}`
  const [p] = await db.insert(projects).values({
    organizationId: ORG, slug: `sp-${sfx}`, name: 'Part Project', connectCode,
  }).returning({ id: projects.id })

  const token = randomBytes(24).toString('hex')
  const tokenId = `sp-tok-${sfx}`
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${tokenId}, ${token}, ${new Date(Date.now() + 3600_000)},
            ${INTERNAL_AGENT_CLIENT_ID}, ${USER}, ${projectScope(p!.id)}, NOW(), NOW())`

  for (const part of parts) {
    const [a] = await db.insert(agents)
      .values({ projectId: p!.id, part, ownerUserId: USER }).returning({ id: agents.id })
    await db.insert(agentConnections).values({
      agentId: a!.id, accessTokenId: tokenId, status: 'connected', connectedAt: new Date(),
    })
  }
  return { projectId: p!.id, connectCode, token }
}

/** Exactly what the pager and the channel send: bearer + ?code= + ?part=. */
async function agentSse(s: Scene, part: string): Promise<{ status: number; body: string }> {
  const res = await app.request(`/api/sse?code=${s.connectCode}&part=${part}`, {
    headers: { authorization: `Bearer ${s.token}`, accept: 'text/event-stream' },
  })
  const body = res.status === 200 ? '' : await res.text()
  if (res.status === 200) await res.body?.cancel()
  return { status: res.status, body }
}

describe('SSE resolves the token to the requested part', () => {
  it('opens the stream for EVERY part the token is connected as', async () => {
    // The regression: one of these got an arbitrary 403 naming the other part.
    const s = await scene('alpha', 'bravo')
    for (const part of ['alpha', 'bravo']) {
      const r = await agentSse(s, part)
      expect(r.status, `part=${part} was refused: ${r.body}`).toBe(200)
    }
  })

  it('still works for the ordinary single-connection agent', async () => {
    const s = await scene('solo')
    expect((await agentSse(s, 'solo')).status).toBe(200)
  })

  it('survives many connections on one token', async () => {
    const parts = ['a1', 'a2', 'a3', 'a4', 'a5']
    const s = await scene(...parts)
    for (const part of parts) {
      expect((await agentSse(s, part)).status, `part=${part}`).toBe(200)
    }
  })

  it('falls back to the connect code for a part the token has no connection for', async () => {
    // Same outcome a caller with no token at all gets: the connect-code branch,
    // which is bearer-independent by design. No token-derived scope is granted.
    const s = await scene('alpha')
    const [other] = await db.insert(agents)
      .values({ projectId: s.projectId, part: 'stranger', ownerUserId: USER })
      .returning({ id: agents.id })
    expect(other).toBeDefined()

    expect((await agentSse(s, 'stranger')).status).toBe(200)
  })

  it('refuses when a token with several connections names no part at all', async () => {
    // Nothing to infer from and no code to fall back to: ambiguity must not be
    // resolved by picking one.
    const s = await scene('alpha', 'bravo')
    const res = await app.request('/api/sse', {
      headers: { authorization: `Bearer ${s.token}`, accept: 'text/event-stream' },
    })
    expect(res.status).toBe(401)
  })

  it('infers the part when the token has exactly one connection and none is named', async () => {
    const s = await scene('solo')
    const res = await app.request('/api/sse', {
      headers: { authorization: `Bearer ${s.token}`, accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)
    await res.body?.cancel()
  })

  it('does not claim a part scope the token does not have', async () => {
    // The old message read "token is scoped to part 'bravo'". Tokens are scoped to
    // a project; sending someone to look for a part scope wastes their time.
    const s = await scene('alpha')
    const res = await app.request(`/api/sse?part=nobody`, {
      headers: { authorization: `Bearer ${s.token}`, accept: 'text/event-stream' },
    })
    // No connect code here, so there is no fallback branch to take.
    expect(res.status).toBe(401)
    expect(await res.text()).not.toMatch(/scoped to part/)
  })
})
