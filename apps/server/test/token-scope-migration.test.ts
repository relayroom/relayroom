/**
 * The BUG-0007 backfill (0014) revokes exactly the connections a token was never
 * scoped to - and nothing else.
 *
 * What it must remove is easy. What it must NOT remove is where this goes wrong:
 * standard OAuth tokens are user-scoped by design and carry no project scope at
 * all, so a scope test applied to them revokes every one of their connections.
 * `agent_connection.access_token_id` is nullable and non-unique, so ONE standard
 * token legitimately holding connections in several projects is a real state, and
 * a blanket migration would wipe a working multi-project setup.
 *
 * global-setup has already applied 0014 to this database, so the statement is
 * re-run here against rows seeded per test. It is a plain UPDATE with no ordering
 * dependence, which is what makes that faithful.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agentConnections, agents, projects } from '@relayroom/db'
import { INTERNAL_AGENT_CLIENT_ID, projectScope } from '@relayroom/shared'
import postgres from 'postgres'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

const MIGRATION = readFileSync(
  fileURLToPath(new URL(
    '../../../packages/db/drizzle/0014_revoke_cross_project_agent_connections.sql',
    import.meta.url,
  )),
  'utf8',
)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

const ORG = `mg-org-${randomBytes(4).toString('hex')}`
const USER = `mg-user-${randomBytes(4).toString('hex')}`
const STANDARD_CLIENT = 'mg-standard-client'

beforeAll(async () => {
  for (const [id, clientId, type] of [
    ['mg-internal-app', INTERNAL_AGENT_CLIENT_ID, 'internal'],
    ['mg-standard-app', STANDARD_CLIENT, 'public'],
  ] as const) {
    await rawSql`
      INSERT INTO better_auth_oauth_application
        (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
      VALUES (${id}, ${'App ' + id}, ${clientId}, NULL,
              'urn:ietf:wg:oauth:2.0:oob', ${type}, false, NOW(), NOW())
      ON CONFLICT (client_id) DO NOTHING`
  }
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER}, 'Migration User', ${USER + '@mg.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${ORG}, 'Migration Org', NOW())`
})

async function project(): Promise<{ id: string; agentId: string }> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: ORG, slug: `mg-${sfx}`, name: 'Migration Project', connectCode: `mg-cc-${sfx}`,
  }).returning({ id: projects.id })
  const [a] = await db.insert(agents)
    .values({ projectId: p!.id, part: 'worker' }).returning({ id: agents.id })
  return { id: p!.id, agentId: a!.id }
}

async function mintToken(clientId: string, scopes: string | null): Promise<string> {
  const id = `mg-tok-${randomBytes(8).toString('hex')}`
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${id}, ${randomBytes(24).toString('hex')}, ${new Date(Date.now() + 3600_000)},
            ${clientId}, ${USER}, ${scopes}, NOW(), NOW())`
  return id
}

async function connection(agentId: string, tokenId: string | null): Promise<string> {
  const [row] = await db.insert(agentConnections)
    .values({ agentId, accessTokenId: tokenId, status: 'connected', connectedAt: new Date() })
    .returning({ id: agentConnections.id })
  return row!.id
}

async function statusOf(connectionId: string): Promise<string> {
  const [row] = await db.select({ status: agentConnections.status })
    .from(agentConnections).where(eq(agentConnections.id, connectionId))
  return row!.status
}

const runMigration = () => rawSql.unsafe(MIGRATION)

describe('0014 revokes cross-project internal connections', () => {
  it('revokes an internal connection outside the token scope', async () => {
    const a = await project()
    const b = await project()
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, projectScope(a.id))
    const stray = await connection(b.agentId, tok)

    await runMigration()
    expect(await statusOf(stray)).toBe('revoked')
  })

  it('keeps the internal connection the token IS scoped to', async () => {
    const a = await project()
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, projectScope(a.id))
    const good = await connection(a.agentId, tok)

    await runMigration()
    expect(await statusOf(good)).toBe('connected')
  })

  it('revokes an internal connection whose token has no usable scope', async () => {
    for (const scopes of [null, '', '   ']) {
      const a = await project()
      const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, scopes)
      const conn = await connection(a.agentId, tok)

      await runMigration()
      expect(await statusOf(conn)).toBe('revoked')
    }
  })

  it('does not match a project id by prefix', async () => {
    // 'project:<id>' as a substring of a longer scope element must not count.
    const a = await project()
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, `${projectScope(a.id)}-extra`)
    const conn = await connection(a.agentId, tok)

    await runMigration()
    expect(await statusOf(conn)).toBe('revoked')
  })
})

describe('0014 preserves everything else', () => {
  it('keeps a standard OAuth connection that carries no project scope', async () => {
    const a = await project()
    const tok = await mintToken(STANDARD_CLIENT, 'openid profile')
    const conn = await connection(a.agentId, tok)

    await runMigration()
    expect(await statusOf(conn)).toBe('connected')
  })

  it('keeps ALL of a standard OAuth token\'s connections across several projects', async () => {
    // The case review 2 caught: access_token_id is nullable and non-unique, so this
    // is a legitimate state, and a scope test applied to a user-scoped token would
    // revoke every one of these.
    const tok = await mintToken(STANDARD_CLIENT, 'openid profile offline_access')
    const conns: string[] = []
    for (let i = 0; i < 3; i++) {
      const p = await project()
      conns.push(await connection(p.agentId, tok))
    }

    await runMigration()
    for (const c of conns) expect(await statusOf(c)).toBe('connected')
  })

  it('keeps a standard OAuth connection even with a null scope', async () => {
    const a = await project()
    const tok = await mintToken(STANDARD_CLIENT, null)
    const conn = await connection(a.agentId, tok)

    await runMigration()
    expect(await statusOf(conn)).toBe('connected')
  })

  it('keeps a connection with no token at all', async () => {
    const a = await project()
    const conn = await connection(a.agentId, null)

    await runMigration()
    expect(await statusOf(conn)).toBe('connected')
  })

  it('is idempotent and leaves an already-revoked row alone', async () => {
    const a = await project()
    const b = await project()
    const tok = await mintToken(INTERNAL_AGENT_CLIENT_ID, projectScope(a.id))
    const good = await connection(a.agentId, tok)
    const stray = await connection(b.agentId, tok)

    await runMigration()
    await runMigration()
    expect(await statusOf(stray)).toBe('revoked')
    expect(await statusOf(good)).toBe('connected')
  })
})

describe('0014 and a refreshed token', () => {
  it('follows the refreshed row, because a refresh copies client_id and scopes', async () => {
    // better-auth writes a new access_token row on refresh, carrying the original
    // client_id and scopes forward. The migration therefore judges the refreshed
    // row on the same scope the original had - asserted against stored columns
    // rather than a hand-built fixture, so a change in what refresh carries shows up
    // here instead of passing silently.
    const a = await project()
    const b = await project()
    const original = await mintToken(INTERNAL_AGENT_CLIENT_ID, projectScope(a.id))

    const [row] = await rawSql`
      SELECT client_id, scopes FROM better_auth_oauth_access_token WHERE id = ${original}`
    expect(row!.client_id).toBe(INTERNAL_AGENT_CLIENT_ID)
    expect(row!.scopes).toBe(projectScope(a.id))

    // A refresh: same client_id and scopes, new token row.
    const refreshed = await mintToken(row!.client_id as string, row!.scopes as string)
    const good = await connection(a.agentId, refreshed)
    const stray = await connection(b.agentId, refreshed)

    await runMigration()
    expect(await statusOf(good)).toBe('connected')
    expect(await statusOf(stray)).toBe('revoked')
  })
})
