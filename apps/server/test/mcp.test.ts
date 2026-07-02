/**
 * MCP resource server tests (F6b)
 *
 * Tests:
 *   1. No token -> 401 + WWW-Authenticate header
 *   2. Valid token + user NOT an org member -> 403
 *   3. Valid token + org member -> connection created + tools work (event tool)
 *   4. Unknown connect code -> 404
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentConnections, agents, configurations, messageRecipients, messages, ownerWakeBudgets, projects, threads, wakeIntents } from '@relayroom/db'
import { and, eq, inArray } from 'drizzle-orm'
import postgres from 'postgres'
import { checkLoopBreaker, resetLoopBreaker } from '../src/wake/pipeline'
import { invalidateWakeFlagCache } from '../src/wake/flag'
import { ensurePending } from '../src/wake/state'
import type { HubBusEvent } from '@relayroom/shared'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { app, db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function ensureInternalClient() {
  await rawSql`
    INSERT INTO better_auth_oauth_application
      (id, name, client_id, client_secret, redirect_urls, type, disabled, created_at, updated_at)
    VALUES
      ('mcp-test-client', 'MCP Test Client', 'relayroom-mcp-test-client',
       NULL, 'urn:ietf:wg:oauth:2.0:oob', 'internal', false, NOW(), NOW())
    ON CONFLICT (client_id) DO NOTHING
  `
}

async function insertTestUser(suffix?: string): Promise<string> {
  const id = `mcp-user-${suffix ?? randomBytes(4).toString('hex')}`
  await rawSql`
    INSERT INTO better_auth_user (id, name, email, email_verified, created_at, updated_at)
    VALUES (
      ${id},
      ${'MCP Test User ' + id},
      ${'mcp-test-' + id + '@example.com'},
      true,
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO NOTHING
  `
  return id
}

async function insertMembership(orgId: string, userId: string): Promise<void> {
  // Ensure the org exists
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${orgId}, ${'Test Org ' + orgId}, NOW())
    ON CONFLICT (id) DO NOTHING
  `
  const memberId = `mem-${randomBytes(6).toString('hex')}`
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${memberId}, ${orgId}, ${userId}, 'member', NOW())
    ON CONFLICT DO NOTHING
  `
}

async function insertTestToken(rawToken: string, userId: string | null): Promise<string> {
  const id = `mcp-tok-${randomBytes(8).toString('hex')}`
  const futureDate = new Date(Date.now() + 1000 * 60 * 60)
  await rawSql`
    INSERT INTO better_auth_oauth_access_token
      (id, access_token, access_token_expires_at, client_id, user_id, scopes, created_at, updated_at)
    VALUES
      (${id}, ${rawToken}, ${futureDate}, 'relayroom-mcp-test-client',
       ${userId}, 'openid profile', NOW(), NOW())
  `
  return id
}

async function deleteTestToken(id: string) {
  await rawSql`DELETE FROM better_auth_oauth_access_token WHERE id = ${id}`
}

async function createTestProject(orgId: string): Promise<{ id: string; connectCode: string }> {
  const connectCode = `mcp-cc-${randomBytes(6).toString('hex')}`
  const slug = `mcp-proj-${randomBytes(4).toString('hex')}`
  const [project] = await db.insert(projects).values({
    organizationId: orgId,
    slug,
    name: 'MCP Test Project',
    connectCode,
  }).returning({ id: projects.id, connectCode: projects.connectCode })
  return { id: project.id, connectCode: connectCode }
}

/** Pre-create agent rows for parts (the web UI's connectAgent does this; the MCP
 *  server no longer auto-creates). Idempotent. */
async function ensureAgents(projectId: string, ...parts: string[]): Promise<void> {
  for (const part of parts) {
    await db.insert(agents).values({ projectId, part }).onConflictDoNothing()
  }
}

/** Call an MCP tool over the JSON-RPC transport and return the parsed tool result.
 * The Streamable HTTP transport answers with an SSE-framed body; we pull the JSON
 * out of the `data:` line. Returns { isError, text } extracted from the first
 * content block. */
async function callTool(
  connectCode: string,
  rawToken: string,
  part: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  // The server no longer auto-creates agents on an MCP call (agents are born only
  // via the web UI's connectAgent). Mirror that here: ensure the caller's agent row
  // exists before the call, the way registration would have.
  const [proj] = await db.select({ id: projects.id }).from(projects)
    .where(eq(projects.connectCode, connectCode)).limit(1)
  if (proj) await db.insert(agents).values({ projectId: proj.id, part }).onConflictDoNothing()

  const res = await app.request(`/mcp/${connectCode}?part=${encodeURIComponent(part)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${rawToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const raw = await res.text()
  // Body is SSE: lines like "event: message\ndata: {...}". Grab the data payload.
  const dataLine = raw.split('\n').find(l => l.startsWith('data:'))
  const parsed = dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : JSON.parse(raw)
  const result = parsed.result ?? {}
  const text = result.content?.[0]?.text ?? ''
  return { isError: Boolean(result.isError), text }
}

/** Boilerplate: a member user + token + project, ready to call tools with. */
async function setupCaller(): Promise<{ projectId: string; connectCode: string; rawToken: string; userId: string }> {
  const orgId = `mcp-org-${randomBytes(4).toString('hex')}`
  const userId = await insertTestUser()
  await insertMembership(orgId, userId)
  const { id: projectId, connectCode } = await createTestProject(orgId)
  const rawToken = randomBytes(32).toString('hex')
  await insertTestToken(rawToken, userId)
  return { projectId, connectCode, rawToken, userId }
}

/** Turn ON wake-budget enforcement for a project (phase 12 feature flag). Without
 *  this, enforcement defaults OFF and cap/loop-breaker/budget rejects are bypassed.
 *  These enforcement tests opt in explicitly. */
async function enableWakeBudget(projectId: string): Promise<void> {
  await db.insert(configurations).values({ scope: 'project', scopeId: projectId, key: 'wake_budget_enabled', value: true })
  invalidateWakeFlagCache()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCP resource server (/mcp/:connectCode)', () => {
  beforeAll(async () => {
    await ensureInternalClient()
  })

  it('DNS rebinding: a foreign Host header is rejected with 403', async () => {
    // Even with a (would-be) valid bearer, a mismatched Host is refused before auth.
    const res = await app.request('/mcp/some-connect-code', {
      method: 'POST',
      headers: { Host: 'evil.attacker.example', Authorization: 'Bearer whatever' },
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/host/i)
  })

  it('no token -> 401 with WWW-Authenticate header', async () => {
    const res = await app.request('/mcp/some-connect-code', { method: 'POST' })
    expect(res.status).toBe(401)
    const wwwAuth = res.headers.get('WWW-Authenticate')
    expect(wwwAuth).toBeTruthy()
    expect(wwwAuth).toContain('Bearer')
    expect(wwwAuth).toContain('oauth-protected-resource')
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/required/)
  })

  it('invalid token -> 401 with WWW-Authenticate header', async () => {
    const res = await app.request('/mcp/some-connect-code', {
      method: 'POST',
      headers: { Authorization: 'Bearer totally-invalid-token-xyz' },
    })
    expect(res.status).toBe(401)
    const wwwAuth = res.headers.get('WWW-Authenticate')
    expect(wwwAuth).toBeTruthy()
    expect(wwwAuth).toContain('Bearer')
  })

  it('unknown connect code -> 404', async () => {
    const userId = await insertTestUser()
    const rawToken = randomBytes(32).toString('hex')
    const tokenId = await insertTestToken(rawToken, userId)

    try {
      const res = await app.request('/mcp/nonexistent-code-xyz', {
        method: 'POST',
        headers: { Authorization: `Bearer ${rawToken}` },
      })
      expect(res.status).toBe(404)
    }
    finally {
      await deleteTestToken(tokenId)
    }
  })

  it('valid token but user NOT an org member -> 403', async () => {
    const orgId = `mcp-org-nomember-${randomBytes(4).toString('hex')}`
    const userId = await insertTestUser()
    const { connectCode } = await createTestProject(orgId)
    // Note: we do NOT insert a membership for userId in orgId

    const rawToken = randomBytes(32).toString('hex')
    const tokenId = await insertTestToken(rawToken, userId)

    try {
      const res = await app.request(`/mcp/${connectCode}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${rawToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      })
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/member/)
    }
    finally {
      await deleteTestToken(tokenId)
    }
  })

  it('archived project -> 404: connect-code endpoints are cut off after archive', async () => {
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'worker')
    // Archive the project: every connect-code lookup must now resolve no project, so
    // the agent bus + the connect-code-only endpoints are cut off (the dashboard copy
    // says archive disables agent connections; before this they kept serving).
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId))

    // MCP transport: project no longer resolves -> 404 unknown connect code.
    const transport = await app.request(`/mcp/${connectCode}?part=worker`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${rawToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(transport.status).toBe(404)
    expect(((await transport.json()) as { error: string }).error).toMatch(/connect code/)

    // Connect-code-only endpoints are cut off too.
    expect((await app.request(`/mcp/${connectCode}/unread?part=worker`)).status).toBe(404)
    expect((await app.request(`/mcp/${connectCode}/relayroom-md`)).status).toBe(404)
  })

  it('ack emits a read bus event (live read receipts) on a first read', async () => {
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'reader', 'sender')
    // 'sender' opens a thread addressed to 'reader'.
    const sent = await callTool(connectCode, rawToken, 'sender', 'send', {
      subject: 'ping', body: 'hi', to: ['reader'],
    })
    const { messageId } = JSON.parse(sent.text) as { threadId: string; messageId: string }

    // Subscribe, then 'reader' acks; a 'read' event for the reader must arrive.
    const reads: Array<{ part: string; messageId: string }> = []
    const listener = (e: HubBusEvent) => {
      if (e.kind === 'read') reads.push({ part: e.part, messageId: e.messageId })
    }
    bus.on('message', listener)
    await callTool(connectCode, rawToken, 'reader', 'ack', { messageId })
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('no read event')), 3000)
      const poll = setInterval(() => {
        if (reads.some((r) => r.part === 'reader' && r.messageId === messageId)) {
          clearInterval(poll); clearTimeout(deadline); resolve()
        }
      }, 10)
    })
    bus.off('message', listener)
  })

  it('ownership: a member with the connect code cannot seize another user\'s agent (403)', async () => {
    const orgId = `mcp-org-own-${randomBytes(4).toString('hex')}`
    const alice = await insertTestUser()
    const bob = await insertTestUser()
    await insertMembership(orgId, alice)
    await insertMembership(orgId, bob)
    const { id: projectId, connectCode } = await createTestProject(orgId)
    // Alice already owns "backend".
    await db.insert(agents).values({ projectId, part: 'backend', ownerUserId: alice })
    // Bob (trusted member) tries to connect that part with HIS token + the shared code.
    const bobToken = randomBytes(32).toString('hex')
    const bobTokenId = await insertTestToken(bobToken, bob)

    try {
      const res = await app.request(`/mcp/${connectCode}?part=backend`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bobToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      })
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/owned by another/)
      // Ownership must be unchanged.
      const [agent] = await db.select().from(agents)
        .where(and(eq(agents.projectId, projectId), eq(agents.part, 'backend')))
      expect(agent!.ownerUserId).toBe(alice)
    }
    finally {
      await deleteTestToken(bobTokenId)
    }
  })

  it('valid token + org member -> connection created, tools/list succeeds', async () => {
    const orgId = `mcp-org-${randomBytes(4).toString('hex')}`
    const userId = await insertTestUser()
    await insertMembership(orgId, userId)
    const { id: projectId, connectCode } = await createTestProject(orgId)
    const rawToken = randomBytes(32).toString('hex')
    const tokenId = await insertTestToken(rawToken, userId)
    await ensureAgents(projectId, 'worker')

    try {
      const res = await app.request(`/mcp/${connectCode}?part=worker`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${rawToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0' },
          },
        }),
      })

      // Authenticated member -> the MCP transport handles the request (200).
      expect(res.status).toBe(200)

      // Verify agent_connection was created in DB
      const [agent] = await db.select()
        .from(agents)
        .where(and(eq(agents.projectId, projectId), eq(agents.part, 'worker')))
      expect(agent).toBeTruthy()
      expect(agent!.ownerUserId).toBe(userId)

      const [connection] = await db.select()
        .from(agentConnections)
        .where(eq(agentConnections.agentId, agent!.id))
      expect(connection).toBeTruthy()
      expect(connection!.accessTokenId).toBe(tokenId)
      expect(connection!.status).toBe('connected')
    }
    finally {
      await deleteTestToken(tokenId)
    }
  })

  it('valid token + member + event tool -> records event in project', async () => {
    const orgId = `mcp-org-evt-${randomBytes(4).toString('hex')}`
    const userId = await insertTestUser()
    await insertMembership(orgId, userId)
    const { id: projectId, connectCode } = await createTestProject(orgId)
    const rawToken = randomBytes(32).toString('hex')
    const tokenId = await insertTestToken(rawToken, userId)
    await ensureAgents(projectId, 'tester')

    try {
      // First initialize
      await app.request(`/mcp/${connectCode}?part=tester`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${rawToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      })

      // Call event tool
      const res = await app.request(`/mcp/${connectCode}?part=tester`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${rawToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'event',
            arguments: {
              type: 'progress',
              detail: { step: 'mcp-test' },
            },
          },
        }),
      })

      expect(res.status).toBe(200)

      // The event tool must record the event in THIS connection's project,
      // never the caller-supplied scope or the ANON sentinel org.
      const { events } = await import('@relayroom/db')
      const { eq: eqFn } = await import('drizzle-orm')
      const evts = await db.select().from(events).where(eqFn(events.projectId, projectId))
      expect(evts.length).toBeGreaterThan(0)
      expect(evts.every(e => e.projectId === projectId)).toBe(true)
    }
    finally {
      await deleteTestToken(tokenId)
    }
  })

  it('invalid part -> 400', async () => {
    const orgId = `mcp-org-part-${randomBytes(4).toString('hex')}`
    const userId = await insertTestUser()
    await insertMembership(orgId, userId)
    const { connectCode } = await createTestProject(orgId)
    const rawToken = randomBytes(32).toString('hex')
    const tokenId = await insertTestToken(rawToken, userId)

    try {
      const res = await app.request(`/mcp/${connectCode}?part=${encodeURIComponent('../evil master')}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${rawToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/part/)
    }
    finally {
      await deleteTestToken(tokenId)
    }
  })

  it('event tool rejects a parentEventId from another project', async () => {
    // Project A (the attacker's connection) and project B (the victim).
    const orgA = `mcp-org-a-${randomBytes(4).toString('hex')}`
    const orgB = `mcp-org-b-${randomBytes(4).toString('hex')}`
    const userId = await insertTestUser()
    await insertMembership(orgA, userId)
    const { id: projectA, connectCode } = await createTestProject(orgA)
    const { id: projectB } = await createTestProject(orgB)

    // Seed an event in project B directly.
    const { events } = await import('@relayroom/db')
    const [victimEvent] = await db.insert(events)
      .values({ projectId: projectB, type: 'progress', detail: {} })
      .returning({ id: events.id })

    const rawToken = randomBytes(32).toString('hex')
    const tokenId = await insertTestToken(rawToken, userId)
    await ensureAgents(projectA, 'worker')

    try {
      await app.request(`/mcp/${connectCode}?part=worker`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${rawToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      })

      const res = await app.request(`/mcp/${connectCode}?part=worker`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${rawToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'event', arguments: { type: 'progress', parentEventId: victimEvent!.id } },
        }),
      })
      expect(res.status).toBe(200)

      // No event in project A may reference project B's event as its parent.
      const { eq: eqFn } = await import('drizzle-orm')
      const aEvents = await db.select().from(events).where(eqFn(events.projectId, projectA))
      expect(aEvents.some(e => e.parentEventId === victimEvent!.id)).toBe(false)
    }
    finally {
      await deleteTestToken(tokenId)
    }
  })
  // ── Pager catch-up: GET /:connectCode/unread ────────────────────────────────
  // Connect-code scoped (no bearer), used by the pager to recover messages it
  // missed while disconnected. Must list unread, exclude read, and stay scoped.

  it('unread endpoint lists unread messages for a part, excludes read ones', async () => {
    const orgId = `mcp-org-unread-${randomBytes(4).toString('hex')}`
    const userId = await insertTestUser()
    await insertMembership(orgId, userId)
    const { id: projectId, connectCode } = await createTestProject(orgId)

    // Seed sender + recipient agents and a thread/message addressed to the recipient.
    const [sender] = await db.insert(agents)
      .values({ projectId, part: 'speaker' }).returning({ id: agents.id })
    const [recipient] = await db.insert(agents)
      .values({ projectId, part: 'listener' }).returning({ id: agents.id })
    const [thread] = await db.insert(threads)
      .values({ projectId, subject: 'missed while offline', createdByAgentId: sender!.id })
      .returning({ id: threads.id })
    const [message] = await db.insert(messages)
      .values({ threadId: thread!.id, fromAgentId: sender!.id, body: 'are you there?' })
      .returning({ id: messages.id })
    await db.insert(messageRecipients)
      .values({ messageId: message!.id, agentId: recipient!.id })

    // Unread now lists the one message, with sender + subject.
    const res = await app.request(`/mcp/${connectCode}/unread?part=listener`)
    expect(res.status).toBe(200)
    const body = await res.json() as { count: number; items: { messageId: string; subject: string; fromPart: string }[] }
    expect(body.count).toBe(1)
    expect(body.items[0]!.messageId).toBe(message!.id)
    expect(body.items[0]!.subject).toBe('missed while offline')
    expect(body.items[0]!.fromPart).toBe('speaker')

    // After it is read (ack'd), unread drops it.
    await db.update(messageRecipients)
      .set({ readAt: new Date() })
      .where(and(eq(messageRecipients.messageId, message!.id), eq(messageRecipients.agentId, recipient!.id)))
    const res2 = await app.request(`/mcp/${connectCode}/unread?part=listener`)
    const body2 = await res2.json() as { count: number }
    expect(body2.count).toBe(0)
  })

  it('unread endpoint: unknown connect code -> 404, invalid part -> 400', async () => {
    const res404 = await app.request('/mcp/nonexistent-code-xyz/unread?part=listener')
    expect(res404.status).toBe(404)

    const orgId = `mcp-org-unread2-${randomBytes(4).toString('hex')}`
    const userId = await insertTestUser()
    await insertMembership(orgId, userId)
    const { connectCode } = await createTestProject(orgId)
    const res400 = await app.request(`/mcp/${connectCode}/unread?part=${encodeURIComponent('../evil master')}`)
    expect(res400.status).toBe(400)
  })

  // ── send/reply unified wake pipeline (phase 04) ──────────────────────────────

  it('oversized broadcast rejected, no message row created', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await enableWakeBudget(projectId)
    await db.update(projects).set({ maxBroadcastRecipients: 2 }).where(eq(projects.id, projectId))
    await ensureAgents(projectId, 'a', 'b', 'c')

    const r = await callTool(connectCode, rawToken, 'sender', 'send', {
      subject: 'too many',
      body: 'hi everyone',
      to: ['a', 'b', 'c'],
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/exceeds|cap/)

    // No message rows landed (the cap fired before the message insert).
    const rows = await db.select({ id: messages.id })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(eq(threads.projectId, projectId))
    expect(rows.length).toBe(0)

    // And no orphan EMPTY thread is left behind (A-7): the rejected send removes
    // the thread it had just created.
    const threadRows = await db.select({ id: threads.id })
      .from(threads)
      .where(eq(threads.projectId, projectId))
    expect(threadRows.length).toBe(0)
  })

  it('human part excluded from the broadcast cap, counted in recipientCount', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await db.update(projects).set({ maxBroadcastRecipients: 2 }).where(eq(projects.id, projectId))
    await ensureAgents(projectId, 'a', 'b')

    const r = await callTool(connectCode, rawToken, 'sender', 'send', {
      subject: 'with human',
      body: 'fyi',
      to: ['a', 'b', 'human'],
    })
    expect(r.isError).toBe(false)
    const { messageId } = JSON.parse(r.text) as { messageId: string }

    const [msg] = await db.select({ recipientCount: messages.recipientCount })
      .from(messages).where(eq(messages.id, messageId))
    expect(msg!.recipientCount).toBe(3) // a, b, human

    const recips = await db.select({ id: messageRecipients.agentId })
      .from(messageRecipients).where(eq(messageRecipients.messageId, messageId))
    expect(recips.length).toBe(3)
  })

  it('recipientCount denormalized on the message row', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'x', 'y', 'z')
    const r = await callTool(connectCode, rawToken, 'sender', 'send', {
      subject: 'count me',
      body: 'three recipients',
      to: ['x', 'y', 'z'],
    })
    expect(r.isError).toBe(false)
    const { messageId } = JSON.parse(r.text) as { messageId: string }
    const [msg] = await db.select({ recipientCount: messages.recipientCount })
      .from(messages).where(eq(messages.id, messageId))
    expect(msg!.recipientCount).toBe(3)
  })

  it('loop-breaker trips on rapid identical sends (4th identical send rejected)', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await enableWakeBudget(projectId)
    const payload = { subject: 'spam', body: 'same body', to: ['victim'] }

    const r1 = await callTool(connectCode, rawToken, 'looper', 'send', payload)
    const r2 = await callTool(connectCode, rawToken, 'looper', 'send', payload)
    const r3 = await callTool(connectCode, rawToken, 'looper', 'send', payload)
    expect(r1.isError).toBe(false)
    expect(r2.isError).toBe(false)
    expect(r3.isError).toBe(false)
    const r4 = await callTool(connectCode, rawToken, 'looper', 'send', payload)
    expect(r4.isError).toBe(true)
    expect(r4.text).toMatch(/loop|same message/)
  })

  it('checkLoopBreaker unit: 20 sends/min rate cap, 21st rejected', () => {
    resetLoopBreaker()
    const owner = `owner-${randomBytes(4).toString('hex')}`
    const conn = `conn-${randomBytes(4).toString('hex')}`
    // Distinct bodies so the identical-payload breaker never fires first.
    for (let i = 0; i < 20; i++) {
      const res = checkLoopBreaker(owner, conn, 'scope', `body-${i}`)
      expect(res.ok).toBe(true)
    }
    const over = checkLoopBreaker(owner, conn, 'scope', 'body-21')
    expect(over.ok).toBe(false)
    expect(over.reason).toBe('rate')
  })

  it('reply routes through the same pipeline, fans out to the original sender', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()

    // A (the caller's "sender" part) sends to B, creating a thread.
    const sent = await callTool(connectCode, rawToken, 'alpha', 'send', {
      subject: 'ping pong',
      body: 'hello B',
      to: ['beta'],
    })
    expect(sent.isError).toBe(false)
    const { threadId } = JSON.parse(sent.text) as { threadId: string }

    // B replies. The reply must fan out to alpha (the original sender), via dispatch.
    const replied = await callTool(connectCode, rawToken, 'beta', 'reply', {
      threadId,
      body: 'hello back A',
    })
    expect(replied.isError).toBe(false)
    const { messageId } = JSON.parse(replied.text) as { messageId: string }

    // alpha is a recipient of the reply message.
    const [alpha] = await db.select({ id: agents.id })
      .from(agents).where(and(eq(agents.projectId, projectId), eq(agents.part, 'alpha')))
    const recips = await db.select({ agentId: messageRecipients.agentId })
      .from(messageRecipients).where(eq(messageRecipients.messageId, messageId))
    expect(recips.some(r => r.agentId === alpha!.id)).toBe(true)
  })

  it('reply is subject to the loop-breaker too (4th identical reply rejected)', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await enableWakeBudget(projectId)
    const sent = await callTool(connectCode, rawToken, 'alpha', 'send', {
      subject: 'thread', body: 'open', to: ['beta'],
    })
    const { threadId } = JSON.parse(sent.text) as { threadId: string }

    const payload = { threadId, body: 'same reply' }
    await callTool(connectCode, rawToken, 'beta', 'reply', payload)
    await callTool(connectCode, rawToken, 'beta', 'reply', payload)
    await callTool(connectCode, rawToken, 'beta', 'reply', payload)
    const r4 = await callTool(connectCode, rawToken, 'beta', 'reply', payload)
    expect(r4.isError).toBe(true)
    expect(r4.text).toMatch(/loop|same message/)
  })

  it('budget-suppressed recipient keeps the message row but gets no wake_intent', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await enableWakeBudget(projectId)

    // Recipient with no owner principal -> reserve denies ('no_owner') -> suppressed.
    // (A part that never connected has ownerUserId null; the budget floor only
    // rescues owned principals, so this is the deterministic suppression case.)
    const [recipient] = await db.insert(agents)
      .values({ projectId, part: 'broke', ownerUserId: null })
      .returning({ id: agents.id })

    const r = await callTool(connectCode, rawToken, 'sender', 'send', {
      subject: 'no wake for you',
      body: 'budget exhausted',
      to: ['broke'],
    })
    expect(r.isError).toBe(false)
    const { messageId } = JSON.parse(r.text) as { messageId: string }

    // Delivery preserved: the message-recipient row exists.
    const recips = await db.select({ agentId: messageRecipients.agentId })
      .from(messageRecipients)
      .where(and(eq(messageRecipients.messageId, messageId), eq(messageRecipients.agentId, recipient!.id)))
    expect(recips.length).toBe(1)

    // Wake suppressed: no active wake_intent for that agent.
    const intents = await db.select({ id: wakeIntents.id })
      .from(wakeIntents)
      .where(and(
        eq(wakeIntents.agentId, recipient!.id),
        inArray(wakeIntents.state, ['pending', 'delivered', 'activated']),
      ))
    expect(intents.length).toBe(0)
  })

  it('budget-available recipient gets an active wake_intent', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()

    const richOwner = await insertTestUser()
    await db.insert(ownerWakeBudgets)
      .values({ userId: richOwner, wakesPerHour: 30, urgentPerHour: 5 })
      .onConflictDoNothing()
    const [recipient] = await db.insert(agents)
      .values({ projectId, part: 'awake', ownerUserId: richOwner })
      .returning({ id: agents.id })

    const r = await callTool(connectCode, rawToken, 'sender', 'send', {
      subject: 'wake up',
      body: 'you have budget',
      to: ['awake'],
    })
    expect(r.isError).toBe(false)

    const intents = await db.select({ id: wakeIntents.id })
      .from(wakeIntents)
      .where(and(
        eq(wakeIntents.agentId, recipient!.id),
        inArray(wakeIntents.state, ['pending', 'delivered', 'activated']),
      ))
    expect(intents.length).toBe(1)
  })
})

describe('wake-loop fix: close / scoping / search', () => {
  beforeAll(async () => {
    await ensureInternalClient()
  })

  it('close marks a thread closed and a later reply is rejected', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'peer')

    const sent = await callTool(connectCode, rawToken, 'sender', 'send',
      { subject: 'q', body: 'question?', to: ['peer'] })
    expect(sent.isError).toBe(false)
    const { threadId } = JSON.parse(sent.text) as { threadId: string }

    const closed = await callTool(connectCode, rawToken, 'sender', 'close', { threadId })
    expect(closed.isError).toBe(false)
    const [t] = await db.select({ status: threads.status }).from(threads).where(eq(threads.id, threadId))
    expect(t!.status).toBe('closed')

    // A reply to a closed thread is rejected - this is the loop terminator.
    const reply = await callTool(connectCode, rawToken, 'peer', 'reply', { threadId, body: 'late' })
    expect(reply.isError).toBe(true)
    expect(reply.text).toMatch(/closed/)
  })

  it('closing a thread clears its unread (no perpetual wake on a closed thread)', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'peer')

    const sent = await callTool(connectCode, rawToken, 'sender', 'send',
      { subject: 'ping', body: 'hello peer', to: ['peer'] })
    const { threadId, messageId } = JSON.parse(sent.text) as { threadId: string; messageId: string }

    // peer has an unread recipient row before close.
    const before = await db.select({ readAt: messageRecipients.readAt })
      .from(messageRecipients).where(eq(messageRecipients.messageId, messageId))
    expect(before.some(r => r.readAt === null)).toBe(true)

    await callTool(connectCode, rawToken, 'sender', 'close', { threadId })

    // After close, no unread remains for the thread - so pending-wake/sweep can't
    // re-fire (the bug was an unread stuck in a closed thread waking forever).
    const after = await db.select({ readAt: messageRecipients.readAt })
      .from(messageRecipients).where(eq(messageRecipients.messageId, messageId))
    expect(after.every(r => r.readAt !== null)).toBe(true)
  })

  it('ack of the last unread settles the active wake (agent-driven completion)', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'peer')
    const [peer] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, 'peer')))

    const sent = await callTool(connectCode, rawToken, 'sender', 'send',
      { subject: 'do x', body: 'please do x', to: ['peer'] })
    const { messageId } = JSON.parse(sent.text) as { messageId: string }

    // Simulate the wake the pager would be carrying for peer.
    await ensurePending(db, peer!.id, { epoch: 0, reason: 'message' })
    const before = (await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, peer!.id)))
      .filter(r => ['pending', 'delivered', 'activated'].includes(r.state))
    expect(before.length).toBe(1)

    // peer acks its only unread -> caught up -> the wake must settle.
    const ack = await callTool(connectCode, rawToken, 'peer', 'ack', { messageId })
    expect(ack.isError).toBe(false)
    const after = (await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, peer!.id)))
      .filter(r => ['pending', 'delivered', 'activated'].includes(r.state))
    expect(after.length).toBe(0) // settled
  })

  it('inbox with nothing unread settles a stale active wake (empty-inbox loop fix)', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'idle')
    const [idle] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, 'idle')))

    // A lingering active wake with NO unread (the exact stuck state agents hit).
    await ensurePending(db, idle!.id, { epoch: 0, reason: 'message' })

    const inbox = await callTool(connectCode, rawToken, 'idle', 'inbox', {})
    expect((JSON.parse(inbox.text) as unknown[]).length).toBe(0)

    const after = (await db.select().from(wakeIntents).where(eq(wakeIntents.agentId, idle!.id)))
      .filter(r => ['pending', 'delivered', 'activated'].includes(r.state))
    expect(after.length).toBe(0) // checking an empty inbox ended the wake
  })

  it('send to an unregistered part drops it (no phantom agent, not a recipient)', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'real')

    const r = await callTool(connectCode, rawToken, 'sender', 'send',
      { subject: 'mixed', body: 'hi', to: ['real', 'ghost'] })
    expect(r.isError).toBe(false)
    const { messageId } = JSON.parse(r.text) as { messageId: string }

    // Only 'real' is a recipient; 'ghost' was dropped, never auto-created.
    const recips = await db.select({ id: messageRecipients.agentId })
      .from(messageRecipients).where(eq(messageRecipients.messageId, messageId))
    expect(recips.length).toBe(1)
    const ghost = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.part, 'ghost')))
    expect(ghost.length).toBe(0)
  })

  it('inbox excludes messages whose thread is closed', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'peer')

    const sent = await callTool(connectCode, rawToken, 'sender', 'send',
      { subject: 'hello', body: 'hi peer', to: ['peer'] })
    const { threadId } = JSON.parse(sent.text) as { threadId: string }

    let inbox = await callTool(connectCode, rawToken, 'peer', 'inbox', {})
    expect((JSON.parse(inbox.text) as unknown[]).length).toBe(1)

    await callTool(connectCode, rawToken, 'peer', 'close', { threadId })
    inbox = await callTool(connectCode, rawToken, 'peer', 'inbox', {})
    expect((JSON.parse(inbox.text) as unknown[]).length).toBe(0)
  })

  it('search finds a thread by subject for a non-participant', async () => {
    resetLoopBreaker()
    const { projectId, connectCode, rawToken } = await setupCaller()
    await ensureAgents(projectId, 'peer')

    await callTool(connectCode, rawToken, 'sender', 'send',
      { subject: 'deployment plan zeta', body: 'the details', to: ['peer'] })

    // 'other' is not a participant but can still find the thread.
    const res = await callTool(connectCode, rawToken, 'other', 'search', { query: 'deployment' })
    expect(res.isError).toBe(false)
    const rows = JSON.parse(res.text) as Array<{ subject: string }>
    expect(rows.some(r => r.subject.includes('deployment plan zeta'))).toBe(true)
  })
})

describe('/.well-known/oauth-protected-resource', () => {
  it('returns valid RFC 9728 metadata', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource')
    expect(res.status).toBe(200)
    const body = await res.json() as { resource: string; authorization_servers: string[] }
    expect(body.resource).toBeTruthy()
    expect(Array.isArray(body.authorization_servers)).toBe(true)
    expect(body.authorization_servers.length).toBeGreaterThan(0)
  })
})
