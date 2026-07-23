/**
 * Bearer enforcement on the connect-code endpoints (SRV-H2).
 *
 * The connect code is project-wide, travels in the URL path, never expires, and a
 * ban cannot take it away - banProjectMember deletes the member's tokens, which
 * shut the MCP path immediately while these endpoints kept answering. `part` was
 * an unauthenticated claim on top of that, so a code-holder could name any part
 * and read its unread subjects.
 *
 * Now the token is authoritative for (user, project) and `part` is checked against
 * it. The token cannot IDENTIFY a part - one token can hold agent_connection rows
 * for several parts - so the request still names one and the caller must own it.
 *
 * Two enforcement levels, by whether an un-upgraded client would fail LOUDLY:
 *   required - /wake/claim, /wake/delivered, /pending-wake. The pager and the
 *              channel already send the header, and a pager that cannot claim a
 *              lease stops nudging where someone will notice.
 *   grace    - /heartbeat, /usage, /role, /relayroom-md, /unread. Each of these
 *              fails silently in a client that has not been upgraded: the
 *              ask-guard fails open, the usage hook swallows its errors, and the
 *              tmux status bar's inbox counter keeps displaying its last value.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agents, projectAccess, projects } from '@relayroom/db'
import postgres from 'postgres'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const CLIENT_ID = 'relayroom-runtime-auth-client'

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('runtime-auth-client', 'Runtime Auth Test Client', ${CLIENT_ID},
            NULL, 'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
})

async function makeUser(orgId: string, sfx: string): Promise<{ userId: string; token: string }> {
  const userId = `ra-user-${sfx}`
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${'User ' + userId}, ${userId + '@runtime.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'ra-mem-' + sfx}, ${orgId}, ${userId}, 'member', NOW())`
  const token = randomBytes(24).toString('hex')
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${'ra-tok-' + sfx}, ${token}, ${new Date(Date.now() + 3600_000)},
            ${CLIENT_ID}, ${userId}, 'openid profile', NOW(), NOW())`
  return { userId, token }
}

interface Scene {
  projectId: string
  connectCode: string
  orgId: string
  owner: { userId: string; token: string }
  agentId: string
}

/** A project with one part owned by `owner`. */
async function scene(part = 'worker'): Promise<Scene> {
  const sfx = randomBytes(6).toString('hex')
  const orgId = `ra-org-${sfx}`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${orgId}, ${'Org ' + orgId}, NOW())`

  const owner = await makeUser(orgId, sfx)
  const connectCode = `ra-cc-${sfx}`
  const [project] = await db.insert(projects).values({
    organizationId: orgId, slug: `ra-proj-${sfx}`, name: 'Runtime Auth Project', connectCode,
  }).returning({ id: projects.id })

  const [agent] = await db.insert(agents)
    .values({ projectId: project!.id, part, ownerUserId: owner.userId })
    .returning({ id: agents.id })

  return { projectId: project!.id, connectCode, orgId, owner, agentId: agent!.id }
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

describe('bearer required (wake delivery)', () => {
  it('/wake/claim refuses a request with no bearer token, with a challenge header', async () => {
    const s = await scene()
    const res = await app.request(`/mcp/${s.connectCode}/wake/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'worker', holder: 'h1' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toMatch(/Bearer/)
  })

  it('/wake/claim and /pending-wake refuse a request with no bearer token', async () => {
    const s = await scene()
    const claim = await app.request(`/mcp/${s.connectCode}/wake/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'worker', holder: 'h1' }),
    })
    expect(claim.status).toBe(401)

    const pending = await app.request(`/mcp/${s.connectCode}/pending-wake?part=worker&holder=h1`)
    expect(pending.status).toBe(401)
  })

  it('/wake/claim still works for the owning pager', async () => {
    const s = await scene()
    const res = await app.request(`/mcp/${s.connectCode}/wake/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(s.owner.token) },
      body: JSON.stringify({ part: 'worker', holder: 'h1' }),
    })
    // No active wake to lease, but it got past authorization - that is the point.
    expect(res.status).toBe(200)
    expect((await res.json()) as { noWake?: boolean }).toMatchObject({ noWake: true })
  })
})

describe('grace period (clients that fail silently)', () => {
  it('/unread still answers the tmux status bar, which sends no token', async () => {
    // The inbox counter in the status bar is a curl line in the generated rr.sh
    // (packages/cli/src/init.ts). It has no Authorization header yet, and on a
    // failed fetch it keeps displaying its last value - so rejecting it here would
    // freeze the number rather than show anyone an error.
    const s = await scene()
    const res = await app.request(`/mcp/${s.connectCode}/unread?part=worker`)
    expect(res.status).toBe(200)
  })


  it('/heartbeat still accepts a client that sends no bearer token', async () => {
    const s = await scene()
    const res = await app.request(`/mcp/${s.connectCode}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'worker' }),
    })
    expect(res.status).toBe(200)
  })

  it('/heartbeat accepts the owner when the token IS sent', async () => {
    const s = await scene()
    const res = await app.request(`/mcp/${s.connectCode}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(s.owner.token) },
      body: JSON.stringify({ part: 'worker' }),
    })
    expect(res.status).toBe(200)
  })

  it('a BAD token is rejected rather than falling back to the legacy path', async () => {
    // The grace period is for clients that send nothing yet. A token that is present
    // but expired or revoked must fail: silently downgrading it to weaker auth would
    // undo the expiry it is being checked for.
    const s = await scene()
    const res = await app.request(`/mcp/${s.connectCode}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer('not-a-real-token') },
      body: JSON.stringify({ part: 'worker' }),
    })
    expect(res.status).toBe(401)
  })

  it('a banned member is refused even on a grace endpoint when the token is sent', async () => {
    const s = await scene()
    await db.insert(projectAccess).values({
      projectId: s.projectId, userId: s.owner.userId, level: 'write', bannedAt: new Date(),
    })
    const res = await app.request(`/mcp/${s.connectCode}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(s.owner.token) },
      body: JSON.stringify({ part: 'worker' }),
    })
    expect(res.status).toBe(403)
  })

  it('/relayroom-md authorizes at project level, with no part', async () => {
    const s = await scene()
    const withToken = await app.request(`/mcp/${s.connectCode}/relayroom-md`, {
      headers: bearer(s.owner.token),
    })
    expect(withToken.status).toBe(200)

    // A member of a DIFFERENT org has no business reading this project's playbook.
    const otherOrg = `ra-org-out-${randomBytes(6).toString('hex')}`
    await rawSql`
      INSERT INTO better_auth_organization (id, name, created_at)
      VALUES (${otherOrg}, 'Outsider Org', NOW())`
    const outsider = await makeUser(otherOrg, randomBytes(6).toString('hex'))
    const res = await app.request(`/mcp/${s.connectCode}/relayroom-md`, {
      headers: bearer(outsider.token),
    })
    expect(res.status).toBe(403)
  })
})

describe('part ownership', () => {
  it('/unread accepts the part owner', async () => {
    const s = await scene()
    const res = await app.request(`/mcp/${s.connectCode}/unread?part=worker`, {
      headers: bearer(s.owner.token),
    })
    expect(res.status).toBe(200)
  })

  it('/unread refuses another member reading a part they do not own', async () => {
    const s = await scene()
    // A second member of the same org: authenticated, in the project, not the owner.
    const other = await makeUser(s.orgId, randomBytes(6).toString('hex'))
    const res = await app.request(`/mcp/${s.connectCode}/unread?part=worker`, {
      headers: bearer(other.token),
    })
    expect(res.status).toBe(403)
  })

  it('/unread refuses a banned member who still holds the connect code', async () => {
    const s = await scene()
    // The ban is what the connect code could not express: the code is project-wide,
    // so it cannot be rotated for one member without cutting off everyone.
    await db.insert(projectAccess).values({
      projectId: s.projectId, userId: s.owner.userId, level: 'write', bannedAt: new Date(),
    })
    const res = await app.request(`/mcp/${s.connectCode}/unread?part=worker`, {
      headers: bearer(s.owner.token),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/banned/)
  })

  it('a deleted part is refused even for its owner', async () => {
    const s = await scene()
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, s.agentId))
    const res = await app.request(`/mcp/${s.connectCode}/unread?part=worker`, {
      headers: bearer(s.owner.token),
    })
    expect(res.status).toBe(404)
  })

  it('an unregistered part is refused', async () => {
    const s = await scene()
    const res = await app.request(`/mcp/${s.connectCode}/unread?part=ghostpart`, {
      headers: bearer(s.owner.token),
    })
    expect(res.status).toBe(404)
  })
})
