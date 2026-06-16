/**
 * Governance ban/unban server enforcement (phase 09).
 *
 * Covers the side effects of applyBan/applyUnban and the bannedAt enforcement gate
 * in mcp.ts resolveConnection (driven over the real HTTP route):
 *  - ban revokes the member's agent connections
 *  - ban blocks connect/send (403 from resolveConnection) until unban
 *  - ban cancels + refunds pending wakes (reservation reclaimed in the budget window)
 *  - in-flight messages are preserved (not deleted)
 *  - reversibility: project_access row survives, bannedAt toggles null<->set
 *  - org scope bans on every project in the org
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import {
  agentConnections,
  agents,
  applyBan,
  applyUnban,
  messages,
  projectAccess,
  projects,
  threads,
  wakeIntents,
} from '@relayroom/db'
import { reserve } from '../src/wake/budget'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function ensureInternalClient() {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES
      ('ban-test-client', 'Ban Test Client', 'relayroom-ban-test-client',
       NULL, 'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING
  `
}

async function insertUser(): Promise<string> {
  const id = `ban-user-${randomBytes(5).toString('hex')}`
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${id}, ${'Ban User ' + id}, ${id + '@test.local'}, true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `
  return id
}

async function insertOrgMember(orgId: string, userId: string): Promise<void> {
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${orgId}, ${'Org ' + orgId}, NOW())
    ON CONFLICT (id) DO NOTHING
  `
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'mem-' + randomBytes(6).toString('hex')}, ${orgId}, ${userId}, 'member', NOW())
    ON CONFLICT DO NOTHING
  `
}

async function insertToken(rawToken: string, userId: string): Promise<string> {
  const id = `ban-tok-${randomBytes(8).toString('hex')}`
  const future = new Date(Date.now() + 1000 * 60 * 60)
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES (${id}, ${rawToken}, ${future}, 'relayroom-ban-test-client', ${userId}, 'openid', NOW(), NOW())
  `
  return id
}

async function makeProject(orgId: string): Promise<{ id: string; connectCode: string }> {
  const connectCode = `ban-cc-${randomBytes(6).toString('hex')}`
  const [p] = await db
    .insert(projects)
    .values({
      organizationId: orgId,
      slug: `ban-proj-${randomBytes(4).toString('hex')}`,
      name: 'Ban Test Project',
      connectCode,
    })
    .returning({ id: projects.id })
  return { id: p.id, connectCode }
}

/** Drive resolveConnection over the real HTTP route; returns the status. */
async function connectStatus(connectCode: string, rawToken: string, part: string): Promise<number> {
  const res = await app.request(`/mcp/${connectCode}?part=${encodeURIComponent(part)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${rawToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  return res.status
}

// The principal recorded as bannedByUserId must exist (FK to better_auth_user).
const ACTOR = 'ban-actor-fixed'

beforeAll(async () => {
  await ensureInternalClient()
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (${ACTOR}, 'Ban Actor', ${ACTOR + '@test.local'}, true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `
})

describe('applyBan side effects', () => {
  it('revokes connections, blocks connect (403), preserves messages, is reversible', async () => {
    const orgId = `ban-org-${randomBytes(4).toString('hex')}`
    const userId = await insertUser()
    await insertOrgMember(orgId, userId)
    const { id: projectId, connectCode } = await makeProject(orgId)
    await db.insert(projectAccess).values({ projectId, userId, level: 'write' })

    const rawToken = randomBytes(32).toString('hex')
    const tokenId = await insertToken(rawToken, userId)

    // The web UI registers the agent before any MCP call (the server no longer
    // auto-creates). Pre-create it; then connect creates the agent_connection.
    await db.insert(agents).values({ projectId, part: 'alpha' }).onConflictDoNothing()

    // A live connection through the MCP route (creates the connection).
    expect(await connectStatus(connectCode, rawToken, 'alpha')).toBe(200)

    // An in-flight message authored by this member (must survive the ban).
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, 'alpha')))
      .limit(1)
    const [thread] = await db
      .insert(threads)
      .values({ projectId, subject: 'pre-ban', createdByAgentId: agent!.id })
      .returning({ id: threads.id })
    const [msg] = await db
      .insert(messages)
      .values({ threadId: thread!.id, fromAgentId: agent!.id, body: 'still here' })
      .returning({ id: messages.id })

    // Ban.
    const result = await applyBan(db, {
      projectId,
      userId,
      scope: { kind: 'project' },
      bannedByUserId: ACTOR,
      orgId,
    })
    expect(result.revokedConnections).toBeGreaterThanOrEqual(1)

    // Connection revoked.
    const conns = await db
      .select({ status: agentConnections.status })
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agent!.id))
    expect(conns.every((c) => c.status === 'revoked')).toBe(true)

    // bannedAt set, row preserved (NOT a hard delete).
    const [pa] = await db
      .select({ bannedAt: projectAccess.bannedAt, bannedBy: projectAccess.bannedByUserId })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))
    expect(pa!.bannedAt).not.toBeNull()
    expect(pa!.bannedBy).toBe(ACTOR)

    // Token invalidated AND bannedAt gate: a fresh connect attempt is 403.
    // (Mint a fresh token to prove the bannedAt gate blocks even a valid token.)
    const freshToken = randomBytes(32).toString('hex')
    await insertToken(freshToken, userId)
    expect(await connectStatus(connectCode, freshToken, 'alpha')).toBe(403)

    // In-flight message preserved.
    const [stillThere] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, msg!.id))
    expect(stillThere).toBeTruthy()

    // Unban: bannedAt cleared, row still present, connect allowed again with a token.
    await applyUnban(db, { projectId, userId, scope: { kind: 'project' }, orgId })
    const [pa2] = await db
      .select({ bannedAt: projectAccess.bannedAt })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))
    expect(pa2).toBeTruthy()
    expect(pa2!.bannedAt).toBeNull()

    // Old revoked connection is NOT auto-restored.
    const conns2 = await db
      .select({ status: agentConnections.status })
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agent!.id))
    expect(conns2.some((c) => c.status === 'revoked')).toBe(true)

    // A new connect (fresh token) succeeds post-unban.
    const reToken = randomBytes(32).toString('hex')
    await insertToken(reToken, userId)
    expect(await connectStatus(connectCode, reToken, 'alpha')).toBe(200)

    void tokenId
  })

  it('cancels + refunds pending wakes (reservation reclaimed)', async () => {
    const orgId = `ban-org-${randomBytes(4).toString('hex')}`
    const userId = await insertUser()
    await insertOrgMember(orgId, userId)
    const { id: projectId } = await makeProject(orgId)
    await db.insert(projectAccess).values({ projectId, userId, level: 'write' })

    // Budget = 5 (project floor also 5). Seed 5 pending wakes on this member's
    // agents in this project so BOTH the general cap and the floor are exhausted.
    await rawSql`
      INSERT INTO owner_wake_budget (user_id, wakes_per_hour, urgent_per_hour)
      VALUES (${userId}, 5, 1)
      ON CONFLICT (user_id) DO UPDATE SET wakes_per_hour = 5, urgent_per_hour = 1
    `

    const agentIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const [a] = await db
        .insert(agents)
        .values({ projectId, part: `beta${i}`, ownerUserId: userId })
        .returning({ id: agents.id })
      agentIds.push(a!.id)
      await db.insert(wakeIntents).values({
        agentId: a!.id,
        projectId,
        ownerUserId: userId,
        state: 'pending',
        epoch: 0,
        urgent: false,
        expiresAt: new Date(Date.now() + 600_000),
      })
    }

    // Budget exhausted by the 5 pending reservations (cap reached, floor met).
    const before = await reserve(db, { ownerUserId: userId, projectId, urgent: false })
    expect(before.allowed).toBe(false)

    const result = await applyBan(db, {
      projectId,
      userId,
      scope: { kind: 'project' },
      bannedByUserId: ACTOR,
      orgId,
    })
    expect(result.canceledWakes).toBe(5)
    expect(result.refundedWakes).toBe(5)

    // All intents now terminal 'canceled'.
    const intents = await db
      .select({ state: wakeIntents.state })
      .from(wakeIntents)
      .where(eq(wakeIntents.projectId, projectId))
    expect(intents.every((w) => w.state === 'canceled')).toBe(true)

    // Reservation reclaimed: budget available again (refund via terminal transition).
    const after = await reserve(db, { ownerUserId: userId, projectId, urgent: false })
    expect(after.allowed).toBe(true)
  })

  it('org scope bans on every project in the org', async () => {
    const orgId = `ban-org-${randomBytes(4).toString('hex')}`
    const userId = await insertUser()
    await insertOrgMember(orgId, userId)
    const { id: p1 } = await makeProject(orgId)
    const { id: p2 } = await makeProject(orgId)
    await db.insert(projectAccess).values([
      { projectId: p1, userId, level: 'write' },
      { projectId: p2, userId, level: 'write' },
    ])

    await applyBan(db, {
      projectId: p1,
      userId,
      scope: { kind: 'org' },
      bannedByUserId: ACTOR,
      orgId,
    })

    const rows = await db
      .select({ projectId: projectAccess.projectId, bannedAt: projectAccess.bannedAt })
      .from(projectAccess)
      .where(eq(projectAccess.userId, userId))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.bannedAt !== null)).toBe(true)
  })
})
