/**
 * An agent token may only act on the project it was issued for (BUG-0007).
 *
 * connectAgent records `scopes: "project:<id>"` on every agent token, but nothing
 * read it back. The MCP boundary took the project from the connect code and then
 * authorized on org membership alone, so a token minted for project A
 * authenticated against project B in the same org. The scope was decoration.
 * Shipped in 0.4.1.
 *
 * The subtlety, and the reason this is a predicate rather than a one-line check:
 * TWO issuers write to better_auth_oauth_access_token. Agent tokens come from
 * connectAgent under the internal client id and carry `project:<id>`. Standard
 * MCP authorization-code tokens come from better-auth under some other client id
 * and are user-scoped, carrying no project scope at all. Enforcing "must contain
 * project:<id>" on everything would reject every standard token - so the rule
 * keys off the ISSUER, and the tests below cover both.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { agentConnections, agents, ownerWakeBudgets, projects } from '@relayroom/db'
import postgres from 'postgres'
import { INTERNAL_AGENT_CLIENT_ID, tokenScopeAllowsProject } from '../src/lib/token-scope'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

// ── The predicate itself ──────────────────────────────────────────────────────

describe('tokenScopeAllowsProject', () => {
  const P = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('accepts an internal token scoped to exactly this project', () => {
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, `project:${P}`, P)).toBe(true)
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, `openid project:${P} profile`, P)).toBe(true)
  })

  it('matches by exact element, never by prefix', () => {
    // The caller picks the project by supplying a connect code, so these are
    // attacker-shaped inputs, not hypotheticals.
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, `project:${P}-suffix`, P)).toBe(false)
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, `project:${P.slice(0, 8)}`, P)).toBe(false)
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, `project:${P}`, `${P}-other`)).toBe(false)
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, `notproject:${P}`, P)).toBe(false)
  })

  it('refuses an internal token with no usable scope', () => {
    // A missing scope must not read as an unrestricted one.
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, null, P)).toBe(false)
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, '', P)).toBe(false)
    expect(tokenScopeAllowsProject(INTERNAL_AGENT_CLIENT_ID, '   ', P)).toBe(false)
  })

  it('leaves standard OAuth tokens alone', () => {
    // User-scoped by design: they carry no project scope and must still work.
    expect(tokenScopeAllowsProject('relayroom-mcp-test-client', 'openid profile', P)).toBe(true)
    expect(tokenScopeAllowsProject('some-other-client', null, P)).toBe(true)
    expect(tokenScopeAllowsProject(null, null, P)).toBe(true)
  })
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG = `ts-org-${randomBytes(4).toString('hex')}`
const USER = `ts-user-${randomBytes(4).toString('hex')}`

beforeAll(async () => {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('ts-internal-app', 'Internal Agent Client', ${INTERNAL_AGENT_CLIENT_ID},
            NULL, 'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('ts-standard-app', 'Standard OAuth Client', 'ts-standard-client',
            NULL, 'urn:ietf:wg:oauth:2.0:oob', 'public', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER}, 'Scope Test User', ${USER + '@scope.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'Scope Test Org', NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'ts-mem-' + randomBytes(4).toString('hex')}, ${ORG}, ${USER}, 'member', NOW())`
})

/** A project in the shared org, with one registered part. */
async function project(part: string): Promise<{ id: string; connectCode: string; agentId: string }> {
  const sfx = randomBytes(6).toString('hex')
  const connectCode = `ts-cc-${sfx}`
  const [p] = await db.insert(projects).values({
    organizationId: ORG, slug: `ts-proj-${sfx}`, name: 'Scope Test Project', connectCode,
  }).returning({ id: projects.id })
  const [a] = await db.insert(agents)
    .values({ projectId: p!.id, part }).returning({ id: agents.id })
  return { id: p!.id, connectCode, agentId: a!.id }
}

async function mintToken(clientId: string, scopes: string | null): Promise<{ raw: string; id: string }> {
  const raw = randomBytes(24).toString('hex')
  const id = `ts-tok-${randomBytes(8).toString('hex')}`
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${id}, ${raw}, ${new Date(Date.now() + 3600_000)}, ${clientId}, ${USER}, ${scopes}, NOW(), NOW())`
  return { raw, id }
}

const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
}

function connect(connectCode: string, rawToken: string, part: string) {
  return app.request(`/mcp/${connectCode}?part=${part}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${rawToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(initialize),
  })
}

// ── MCP connect ───────────────────────────────────────────────────────────────

describe('MCP connect enforces the token project scope', () => {
  it('accepts the project the token was issued for', async () => {
    const a = await project('worker')
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, `project:${a.id}`)
    expect((await connect(a.connectCode, tok.raw, 'worker')).status).toBe(200)
  })

  it('refuses another project in the SAME org', async () => {
    // Same org, same user, valid unexpired token - org membership alone said yes.
    const a = await project('worker')
    const b = await project('worker')
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, `project:${a.id}`)

    const res = await connect(b.connectCode, tok.raw, 'worker')
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    // Generic: the caller chose the project, so a detailed refusal is an oracle.
    expect(body.error).not.toMatch(/project:|scope/)
  })

  it('refuses an internal token whose scope is missing or empty', async () => {
    const a = await project('worker')
    for (const scopes of [null, '', '   ']) {
      const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, scopes)
      expect((await connect(a.connectCode, tok.raw, 'worker')).status).toBe(403)
    }
  })

  it('still accepts a standard OAuth token, which carries no project scope', async () => {
    const a = await project('worker')
    const tok = await mintToken('ts-standard-client', 'openid profile')
    expect((await connect(a.connectCode, tok.raw, 'worker')).status).toBe(200)
  })

  it('leaves nothing behind when it refuses', async () => {
    // The gate sits before the ownership compare-and-set, the connection upsert and
    // the budget seed. A refused connect must not have claimed or touched anything.
    const a = await project('worker')
    const b = await project('worker')
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, `project:${a.id}`)

    const [before] = await db.select().from(agents).where(eq(agents.id, b.agentId))
    expect(before!.ownerUserId).toBeNull()
    // Compared before/after rather than asserted empty: this user connected
    // successfully in an earlier case, so a seeded budget row may already exist.
    // What must hold is that the REFUSED connect changed nothing.
    const budgetBefore = await db.select().from(ownerWakeBudgets)
      .where(eq(ownerWakeBudgets.userId, USER))

    expect((await connect(b.connectCode, tok.raw, 'worker')).status).toBe(403)

    const [after] = await db.select().from(agents).where(eq(agents.id, b.agentId))
    expect(after!.ownerUserId).toBeNull()
    expect(after!.lastSeenAt).toEqual(before!.lastSeenAt)

    const conns = await db.select().from(agentConnections)
      .where(eq(agentConnections.accessTokenId, tok.id))
    expect(conns).toHaveLength(0)

    const budgetAfter = await db.select().from(ownerWakeBudgets)
      .where(eq(ownerWakeBudgets.userId, USER))
    expect(budgetAfter).toEqual(budgetBefore)
  })
})

// ── SSE ───────────────────────────────────────────────────────────────────────

/** An already-established connection row, as an agent that connected earlier has. */
async function connectionFor(agentId: string, tokenId: string): Promise<void> {
  await db.insert(agentConnections).values({
    agentId, accessTokenId: tokenId, status: 'connected', connectedAt: new Date(),
  })
}

/** Bearer only - no `?code`. The connect-code SSE branch is deliberately bearer
 *  independent, so passing the code would test that branch instead of this one. */
async function sse(rawToken: string): Promise<number> {
  const res = await app.request('/api/sse', { headers: { authorization: `Bearer ${rawToken}` } })
  await res.body?.cancel()
  return res.status
}

describe('SSE enforces the token project scope', () => {
  it('streams for a connection in the token\'s own project', async () => {
    const a = await project('worker')
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, `project:${a.id}`)
    await connectionFor(a.agentId, tok.id)
    expect(await sse(tok.raw)).toBe(200)
  })

  it('refuses a connection that resolves to a different project', async () => {
    // The project came from whichever agent_connection the token happened to have,
    // and the scope sitting right there was never consulted.
    const a = await project('worker')
    const b = await project('worker')
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, `project:${a.id}`)
    await connectionFor(b.agentId, tok.id)
    expect(await sse(tok.raw)).toBe(401)
  })

  it('still streams for a standard OAuth connection', async () => {
    const a = await project('worker')
    const tok = await mintToken('ts-standard-client', 'openid profile')
    await connectionFor(a.agentId, tok.id)
    expect(await sse(tok.raw)).toBe(200)
  })
})

// ── Runtime endpoints (the connect-code endpoints hardened in SRV-H2) ──────────

describe('runtime endpoints enforce the token project scope', () => {
  it('refuses a token issued for another project', async () => {
    const a = await project('worker')
    const b = await project('worker')
    // Owned by this user in BOTH projects, so ownership alone would let it through.
    await db.update(agents).set({ ownerUserId: USER })
      .where(and(eq(agents.projectId, b.id), eq(agents.part, 'worker')))
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, `project:${a.id}`)

    const res = await app.request(`/mcp/${b.connectCode}/unread?part=worker`, {
      headers: { authorization: `Bearer ${tok.raw}` },
    })
    expect(res.status).toBe(403)
  })

  it('accepts the token in its own project', async () => {
    const a = await project('worker')
    await db.update(agents).set({ ownerUserId: USER })
      .where(and(eq(agents.projectId, a.id), eq(agents.part, 'worker')))
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, `project:${a.id}`)

    const res = await app.request(`/mcp/${a.connectCode}/unread?part=worker`, {
      headers: { authorization: `Bearer ${tok.raw}` },
    })
    expect(res.status).toBe(200)
  })
})
