/**
 * A deleted part stays deleted (SRV-H1).
 *
 * Deleting an agent in the dashboard is a soft delete, and it does not revoke the
 * token or stop the pager running on that machine. `touchAgent` used to set
 * `deletedAt: null` on every activity path, so the next heartbeat - seconds later -
 * silently brought the row back, put it in the roster, and made it a wake recipient
 * again, while the person who deleted it believed it was gone.
 *
 * computeRecipients, the eligibility sweep, and roster all filter `deletedAt`;
 * activity was the one path that undid a removal. These tests pin that shut on the
 * connect-code endpoints (heartbeat, usage) and on the MCP connect path.
 *
 * Deliberate re-add is a different thing and stays allowed: connectAgent upserts
 * with `deletedAt: null` when a part is added again from the dashboard.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { agents, projects } from '@relayroom/db'
import postgres from 'postgres'
import { computeRecipients } from '../src/wake/pipeline'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

interface Fixture {
  projectId: string
  connectCode: string
  userId: string
  rawToken: string
  agentId: string
}

/** A project with one registered, owned part and a live token for its owner. */
async function fixture(part: string): Promise<Fixture> {
  const sfx = randomBytes(6).toString('hex')
  const userId = `del-user-${sfx}`
  const orgId = `del-org-${sfx}`

  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES ('del-test-client', 'Deletion Test Client', 'relayroom-del-test-client',
            NULL, 'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING`
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${'Owner ' + userId}, ${userId + '@deletion.test'}, true, NOW(), NOW())`
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${orgId}, ${'Org ' + orgId}, NOW())`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'del-mem-' + sfx}, ${orgId}, ${userId}, 'member', NOW())`

  const rawToken = randomBytes(24).toString('hex')
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${'del-tok-' + sfx}, ${rawToken}, ${new Date(Date.now() + 3600_000)},
            'relayroom-del-test-client', ${userId}, 'openid profile', NOW(), NOW())`

  const connectCode = `del-cc-${sfx}`
  const [project] = await db.insert(projects).values({
    organizationId: orgId,
    slug: `del-proj-${sfx}`,
    name: 'Deletion Test Project',
    connectCode,
  }).returning({ id: projects.id })

  const [agent] = await db.insert(agents)
    .values({ projectId: project.id, part, ownerUserId: userId })
    .returning({ id: agents.id })

  return { projectId: project.id, connectCode, userId, rawToken, agentId: agent.id }
}

/** The dashboard's delete: soft delete only. No token revoke, no pager shutdown. */
async function softDelete(agentId: string): Promise<void> {
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agentId))
}

async function isLive(agentId: string): Promise<boolean> {
  const [row] = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
  return !!row
}

describe('a soft-deleted part is not revived by its own traffic', () => {
  it('heartbeat is rejected and leaves the part deleted', async () => {
    const f = await fixture('ghost-hb')
    await softDelete(f.agentId)

    const res = await app.request(`/mcp/${f.connectCode}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'ghost-hb' }),
    })

    expect(res.status).toBe(404)
    expect(await isLive(f.agentId)).toBe(false)
  })

  it('a repeating pager cannot wear the deletion down', async () => {
    const f = await fixture('ghost-loop')
    await softDelete(f.agentId)

    for (let i = 0; i < 5; i++) {
      await app.request(`/mcp/${f.connectCode}/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ part: 'ghost-loop' }),
      })
    }

    expect(await isLive(f.agentId)).toBe(false)
  })

  it('usage ingest is rejected and leaves the part deleted', async () => {
    const f = await fixture('ghost-usage')
    await softDelete(f.agentId)

    const res = await app.request(`/mcp/${f.connectCode}/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'ghost-usage', usage: { input_tokens: 10, output_tokens: 5 } }),
    })

    expect(res.status).toBe(404)
    expect(await isLive(f.agentId)).toBe(false)
  })

  it('the still-valid token cannot reconnect a deleted part over MCP', async () => {
    const f = await fixture('ghost-mcp')

    // Sanity: the token connects fine while the part is live.
    const before = await app.request(`/mcp/${f.connectCode}?part=ghost-mcp`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${f.rawToken}`,
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    })
    expect(before.status).toBe(200)

    // Deleting the part does NOT revoke the token, so the same call must now fail.
    await softDelete(f.agentId)
    const after = await app.request(`/mcp/${f.connectCode}?part=ghost-mcp`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${f.rawToken}`,
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    })

    expect(after.status).toBe(404)
    expect(await isLive(f.agentId)).toBe(false)
  })

  it('stays out of the recipient set after a heartbeat attempt', async () => {
    const f = await fixture('ghost-recip')
    await db.insert(agents).values({ projectId: f.projectId, part: 'sender' })
    await softDelete(f.agentId)

    await app.request(`/mcp/${f.connectCode}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'ghost-recip' }),
    })

    const recipients = await computeRecipients(db, f.projectId, 'sender', {
      mode: 'send',
      to: ['ghost-recip'],
    })
    expect(recipients.map(r => r.part)).not.toContain('ghost-recip')
  })
})
