/**
 * MCP resource server at /mcp/:connectCode (F6b)
 *
 * Implements the MCP Streamable HTTP transport over Hono, with:
 * - OAuth-protected resource (RFC 9728) handshake: 401 + WWW-Authenticate on
 *   missing/invalid token so MCP clients discover the auth server.
 * - Token validation: looks up bearer token in better_auth_oauth_access_token,
 *   then resolves the token's user_id.
 * - Connect code -> project resolution (404 if unknown code).
 * - Org membership gate: verifies the token's user is a member of the project's
 *   org (better_auth_member). 403 if not a member.
 * - Get-or-create agent + agent_connection scoped to (project, part, user).
 * - Registers RelayRoom MCP tools scoped to the connection's project/part.
 *
 * Uses WebStandardStreamableHTTPServerTransport (web-standard Request -> Response)
 * so it integrates natively with Hono without bridging to Node.js req/res.
 *
 * Each /mcp/:connectCode request gets its own McpServer + transport instance
 * (stateless mode: sessionIdGenerator: undefined). This keeps the handler
 * simple and horizontally scalable.
 *
 * Auth enforcement on /mcp is UNCONDITIONAL.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import {
  agentConnections,
  agents,
  configurations,
  events,
  getOrCreateAgent,
  messages,
  messageRecipients,
  projectAccess,
  projects,
  threads,
  touchAgent,
  authSchema,
} from '@relayroom/db'
import { alias } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import { z } from 'zod'
import { DEFAULT_RELAYROOM_MD, NEEDS_HUMAN_TAG, resolveAgentColorHex } from '@relayroom/shared'
import type { Bus } from '../bus'
import { BroadcastCapError, dispatch, LoopBreakerError } from '../wake/pipeline'
import { runEligibilitySweep } from '../wake/sweep'
import { settleCaughtUp } from '../wake/state'
import {
  claimLease,
  decidePendingWake,
  markDeliveredFenced,
  releaseLease,
  renewLease,
  type IssueResult,
} from '../lib/wake-lease'
import { shouldWake } from '../wake/issuance'
import { isWakeBudgetEnabled } from '../wake/flag'
import { CapabilityError, getCapabilities, resolveUrgent } from '../priority/capability'
import { seedOwnerWakeBudget } from '../budget/seed-owner-budget'

// ── Token budget helpers ───────────────────────────────────────────────────────

/** Default / max rows a list tool returns, keeping tool output token-lean. */
const INBOX_DEFAULT_LIMIT = 30
const INBOX_MAX_LIMIT = 50
const PREVIEW_CHARS = 160

/**
 * Truncate a message body to a short preview for list views. The full body is
 * fetched on demand via `show`. Collapses whitespace so the preview stays compact.
 */
function preview(body: string, max = PREVIEW_CHARS): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// ── Config ────────────────────────────────────────────────────────────────────

/** The Next.js auth server base URL used for token validation. */
export function getAuthBase(): string {
  return process.env.RELAYROOM_AUTH_BASE_URL ?? 'http://localhost:48800'
}

/** The public base URL of THIS server (used in protected-resource metadata). */
export function getServerBase(): string {
  return process.env.RELAYROOM_SERVER_BASE_URL ?? 'http://localhost:48801'
}

/**
 * Hosts allowed in the `Host` header on /mcp requests (DNS-rebinding defense).
 * A rebinding attacker points a victim-controlled name at this server; the Host
 * header still carries the attacker's name, so we reject anything not on the
 * allowlist. Defaults to this server's own host (from RELAYROOM_SERVER_BASE_URL);
 * override/extend with RELAYROOM_ALLOWED_HOSTS (comma-separated) behind a proxy
 * or tunnel where the public host differs.
 */
export function getAllowedMcpHosts(): Set<string> {
  // Stored as hostnames (port stripped): DNS rebinding turns on the host NAME
  // resolving to our IP, while the port stays fixed, so the name is what matters.
  const hosts = new Set<string>()
  const addHost = (h: string) => {
    const name = h.split(':')[0]?.trim()
    if (name) hosts.add(name)
  }
  try { addHost(new URL(getServerBase()).host) } catch { /* malformed base */ }
  const raw = process.env.RELAYROOM_ALLOWED_HOSTS
  if (raw) for (const h of raw.split(',')) addHost(h)
  return hosts
}

// The superuser can set the public server base from the dashboard (Settings ->
// Environment), stored in `configuration` (scope=global, key=server_base). Its host
// must also pass the DNS-rebinding check, so the /mcp middleware reads it here.
// Cached with a short TTL to keep the hot path off the DB on every request.
let cachedDbHost: { value: string | null; at: number } = { value: null, at: 0 }
const DB_HOST_TTL_MS = 30_000
async function getConfiguredServerHost(db: Db): Promise<string | null> {
  const now = Date.now()
  if (cachedDbHost.at !== 0 && now - cachedDbHost.at < DB_HOST_TTL_MS) return cachedDbHost.value
  let host: string | null = null
  try {
    const [row] = await db
      .select({ value: configurations.value })
      .from(configurations)
      .where(and(
        eq(configurations.scope, 'global'),
        isNull(configurations.scopeId),
        eq(configurations.key, 'server_base'),
      ))
      .limit(1)
    const v = row?.value
    if (typeof v === 'string' && v.length > 0) {
      try { host = new URL(v).host.split(':')[0] ?? null } catch { host = null }
    }
  } catch { host = null }
  cachedDbHost = { value: host, at: now }
  return host
}

// ── Token validation ──────────────────────────────────────────────────────────

interface TokenLookup {
  id: string
  userId: string | null
  accessTokenExpiresAt: Date | null
}

/**
 * Looks up a bearer token directly in better_auth_oauth_access_token via raw SQL.
 * Returns null if not found or expired.
 */
async function lookupOauthToken(db: Db, token: string): Promise<TokenLookup | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pgClient = (db as any).$client
    const rows: Array<{
      id: string
      user_id: string | null
      access_token_expires_at: Date | null
    }> = await pgClient`
      SELECT id, user_id, access_token_expires_at
      FROM better_auth_oauth_access_token
      WHERE access_token = ${token}
        AND (access_token_expires_at IS NULL OR access_token_expires_at > NOW())
      LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      userId: row.user_id,
      accessTokenExpiresAt: row.access_token_expires_at,
    }
  }
  catch {
    return null
  }
}

/**
 * Verifies the user is a member of the given org (better_auth_member).
 * Returns true if userId is a member.
 */
async function isOrgMember(db: Db, orgId: string, userId: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pgClient = (db as any).$client
    const rows: Array<{ id: string }> = await pgClient`
      SELECT id FROM better_auth_member
      WHERE organization_id = ${orgId}
        AND user_id = ${userId}
      LIMIT 1
    `
    return rows.length > 0
  }
  catch {
    return false
  }
}

/**
 * Whether the user is currently banned from the given project (phase 09).
 * project_access.bannedAt is a reversible toggle: non-null = banned.
 */
async function isBannedFromProject(db: Db, projectId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ bannedAt: projectAccess.bannedAt })
    .from(projectAccess)
    .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))
    .limit(1)
  return !!row?.bannedAt
}

// ── Connection context ────────────────────────────────────────────────────────

export interface McpConnectionContext {
  projectId: string
  projectSlug: string
  orgId: string
  part: string
  agentId: string
  connectionId: string
  userId: string
}

/**
 * Validates token, resolves connect code -> project, verifies org membership,
 * and gets-or-creates the agent_connection.
 *
 * Returns a connection context on success, or throws an object with
 * { status: 401 | 403 | 404, error: string } to be returned as JSON.
 */
async function resolveConnection(
  db: Db,
  token: string,
  connectCode: string,
  part: string,
  machineLabel?: string,
): Promise<McpConnectionContext> {
  // 1. Validate token
  const tokenRow = await lookupOauthToken(db, token)
  if (!tokenRow || !tokenRow.userId) {
    throw { status: 401 as const, error: 'invalid or expired token' }
  }

  const userId = tokenRow.userId

  // 2. Resolve connect code -> project
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.connectCode, connectCode), isNull(projects.archivedAt)))
    .limit(1)

  if (!project) {
    throw { status: 404 as const, error: 'unknown connect code' }
  }

  // 3. Verify org membership
  const member = await isOrgMember(db, project.organizationId, userId)
  if (!member) {
    throw { status: 403 as const, error: 'not a member of this project\'s organization' }
  }

  // 3.5 Banned gate (phase 09): a member banned on this project
  // (project_access.bannedAt set) cannot connect or send. Reversible via unban.
  // This is the AUTHORITATIVE boundary even when token invalidation could not
  // reach a project-scoped ban (tokens are user-scoped). Org-scope bans set
  // bannedAt on every project in the org, so this same gate covers them too.
  if (await isBannedFromProject(db, project.id, userId)) {
    throw { status: 403 as const, error: 'banned from this project' }
  }

  // 4. Resolve the agent for (project, part). Agents are created ONLY via the web
  // UI (connectAgent), which registers the row and issues the token before any MCP
  // call. So a connect whose part has no registered agent is rejected here - the
  // MCP path never conjures an agent (that previously let a stray `--part X`
  // command auto-create a phantom agent).
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.projectId, project.id), eq(agents.part, part)))
    .limit(1)

  if (!agent) {
    throw { status: 404 as const, error: 'agent not registered - register this part in the dashboard first' }
  }

  // Ownership is bound to the agent. A connect code is project-shared, so blindly
  // reattaching ownership to whoever connects would let any code-holder seize an
  // existing agent (and its token/connection) — a takeover. Rule: only the current
  // owner may reconnect; an ownerless (first-claim) agent is claimed by this user.
  // Transferring to a different owner is a separate explicit flow, never a side
  // effect of connecting. (Mirror gate in web connectAgent.)
  if (agent.ownerUserId && agent.ownerUserId !== userId) {
    throw { status: 403 as const, error: 'agent is owned by another user; transfer required' }
  }
  // Atomic compare-and-set claim. The WHERE only matches a row that is STILL
  // ownerless or already ours, so a concurrent connect that claimed it first (in
  // the window after our read) makes this update touch 0 rows -> we reject. This
  // closes the TOCTOU between the read above and the write here.
  const claimed = await db
    .update(agents)
    .set({ lastSeenAt: new Date(), ownerUserId: userId })
    .where(and(
      eq(agents.id, agent.id),
      or(isNull(agents.ownerUserId), eq(agents.ownerUserId, userId)),
    ))
    .returning({ id: agents.id })
  if (claimed.length === 0) {
    throw { status: 403 as const, error: 'agent is owned by another user; transfer required' }
  }

  // 4.5 Seed the owner principal's wake-budget row (insert-if-absent, spec 15.1
  // defaults 30/5). The owner userId is verified (org member, not banned) and the
  // agent is secured, so this is the canonical "owner first seen" point. Idempotent:
  // a returning user keeps any slider edits. Best-effort - the budget engine and
  // sliders already fall back to 30/5 when the row is absent, so a seeding failure
  // must not block the connection. No client change is involved (server-side only).
  await seedOwnerWakeBudget(db, userId).catch(err =>
    console.error('[seedOwnerWakeBudget]', err))

  // 5. Get-or-create agent_connection with access_token_id
  const [existingConn] = await db
    .select()
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.agentId, agent.id),
        eq(agentConnections.accessTokenId, tokenRow.id),
      ),
    )
    .limit(1)

  let connection = existingConn
  if (!connection) {
    const [created] = await db
      .insert(agentConnections)
      .values({
        agentId: agent.id,
        accessTokenId: tokenRow.id,
        machineLabel: machineLabel ?? null,
        status: 'connected',
        connectedAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning()
    if (!created) throw { status: 500 as const, error: 'failed to create connection' }
    connection = created
  }
  else {
    // Touch last_seen_at
    await db
      .update(agentConnections)
      .set({ lastSeenAt: new Date(), status: 'connected' })
      .where(eq(agentConnections.id, connection.id))
      .catch(() => undefined)
  }

  return {
    projectId: project.id,
    projectSlug: project.slug,
    orgId: project.organizationId,
    part,
    agentId: agent.id,
    connectionId: connection.id,
    userId,
  }
}

// ── MCP tool registration ─────────────────────────────────────────────────────

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/**
 * A part is the agent's identity label within a project. Constrain it to a
 * predictable slug (lowercase alphanumeric + - _, max 32 chars) so an agent
 * cannot register junk/oversized part names. Note: the agent's ROLE (main vs
 * default) is never derived from `part`, so this is input hygiene, not a
 * privilege boundary.
 */
const isValidPart = (s: string) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s)

/**
 * Creates a new McpServer with all RelayRoom tools registered,
 * scoped to the given connection context.
 */
function createMcpServer(db: Db, bus: Bus, ctx: McpConnectionContext): McpServer {
  const mcp = new McpServer({
    name: 'relayroom',
    version: '0.1.0',
  })

  // ── send: create thread + first message ──────────────────────────────────

  mcp.tool(
    'send',
    'Create a new thread with a first message, addressed to one or more agent parts in this project.',
    {
      subject: z.string().min(1).describe('Thread subject / title'),
      body: z.string().min(1).describe('Message body'),
      to: z.array(z.string()).min(1).describe('Recipient part names (e.g. ["backend", "human"])'),
      tags: z.array(z.string()).optional().describe('Optional tags for the thread'),
      urgent: z.boolean().optional().describe(
        'Set true ONLY for time-critical messages that should wake idle recipients out of band. '
          + 'Draws from a SEPARATE urgent allowance (U), not the normal wake budget. '
          + 'Requires the urgent capability on your project membership; rejected otherwise. '
          + 'A recipient who set U=0 still receives the message but is not woken.',
      ),
      needsHuman: z.boolean().optional().describe(
        'Set true when you are blocked or need an explicit decision from the human operator. '
          + 'This lights up the dashboard notification bell; it clears when a human replies. '
          + 'Requires the needs_human capability; ignored (no bell) otherwise.',
      ),
    },
    async (args) => {
      // Priority gates (phase 06): urgent + needsHuman are (project, member)
      // capabilities, not free self-assertions.
      const caps = await getCapabilities(db, ctx.projectId, ctx.userId)
      let urgent: boolean
      try {
        urgent = resolveUrgent(caps, args.urgent)
      }
      catch (e) {
        if (e instanceof CapabilityError) {
          return { content: [{ type: 'text' as const,
            text: 'error: urgent capability not granted for this project. '
              + 'Ask a project manager to grant it, or resend without urgent.' }],
          isError: true }
        }
        throw e
      }
      // needsHuman: capability-gated, but a missing capability silently no-ops the
      // bell (the message still delivers normally) rather than erroring.
      const canFlagHuman = args.needsHuman === true && caps.has('needs_human')
      const humanIgnored = args.needsHuman === true && !canFlagHuman

      const fromAgent = await touchAgent(db, ctx.projectId, ctx.part)
      const tags = [...new Set([...(args.tags ?? []), ...(canFlagHuman ? [NEEDS_HUMAN_TAG] : [])])]
      const [thread] = await db.insert(threads)
        .values({
          projectId: ctx.projectId,
          subject: args.subject,
          tags,
          createdByAgentId: fromAgent.id,
        })
        .returning()

      const [proj] = await db.select({ cap: projects.maxBroadcastRecipients })
        .from(projects).where(eq(projects.id, ctx.projectId)).limit(1)

      // Feature-flag gate (12): enforcement (cap/loop-breaker/cooldown/budget) is
      // ON only when wake_budget_enabled is set (project > global > OFF). OFF keeps
      // delivery + coalescing + telemetry; it only bypasses the rejects/suppression.
      const enforce = await isWakeBudgetEnabled(db, { projectId: ctx.projectId })

      try {
        const r = await dispatch(db, {
          projectId: ctx.projectId,
          projectSlug: ctx.projectSlug,
          threadId: thread.id,
          subject: args.subject,
          fromPart: ctx.part,
          fromAgentId: fromAgent.id,
          fromUserId: ctx.userId,
          connectionId: ctx.connectionId,
          body: args.body,
          urgent, // phase 06: routes to the separate U lane in shouldWake/reserve
          recipientsSpec: { mode: 'send', to: args.to },
          maxBroadcastRecipients: proj?.cap ?? null,
          enforce,
          emit: (part, messageId) => bus.emit('message', {
            kind: 'message',
            projectId: ctx.projectId,
            project: ctx.projectSlug,
            part,
            threadId: thread.id,
            messageId,
            subject: args.subject,
            fromPart: ctx.part,
          }),
        })
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                threadId: thread.id,
                messageId: r.messageId,
                ...(humanIgnored ? { humanFlagIgnored: 'needs_human capability missing; bell not lit' } : {}),
              }),
            },
          ],
        }
      }
      catch (e) {
        if (e instanceof BroadcastCapError || e instanceof LoopBreakerError) {
          // The reject is thrown BEFORE any message/recipient is written (loop-breaker
          // and cap are pre-write checks), so the thread we just created is empty.
          // Remove that orphan so a rejected send leaves no phantom empty thread in
          // the dashboard. (Full thread+dispatch atomicity is P1c/A-8.)
          await db.delete(threads).where(eq(threads.id, thread.id)).catch(() => undefined)
          return { content: [{ type: 'text' as const, text: `error: ${e.message}` }], isError: true }
        }
        throw e
      }
    },
  )

  // ── reply: add a message to an existing thread ────────────────────────────

  mcp.tool(
    'reply',
    'Reply to an existing thread in this project.',
    {
      threadId: z.string().describe('UUID of the thread to reply to'),
      body: z.string().min(1).describe('Message body'),
      urgent: z.boolean().optional().describe(
        'Set true ONLY for time-critical replies that should wake idle recipients out of band. '
          + 'Draws from a SEPARATE urgent allowance (U), not the normal wake budget. '
          + 'Requires the urgent capability on your project membership; rejected otherwise. '
          + 'A recipient who set U=0 still receives the message but is not woken.',
      ),
      needsHuman: z.boolean().optional().describe(
        'Set true when you are blocked or need an explicit decision from the human operator. '
          + 'This lights up the dashboard notification bell; it clears when a human replies. '
          + 'Requires the needs_human capability; ignored (no bell) otherwise.',
      ),
    },
    async (args) => {
      if (!isUuid(args.threadId)) {
        return { content: [{ type: 'text' as const, text: 'error: invalid threadId' }], isError: true }
      }
      const [thread] = await db.select().from(threads).where(eq(threads.id, args.threadId))
      if (!thread) {
        return { content: [{ type: 'text' as const, text: 'error: thread not found' }], isError: true }
      }
      if (thread.projectId !== ctx.projectId) {
        return { content: [{ type: 'text' as const, text: 'error: thread not in your project' }], isError: true }
      }
      // A closed/canceled thread is done - no more replies (this is what breaks the
      // endless ack-of-ack loop). Open a new thread if there is genuinely more to say.
      if (thread.status === 'closed' || thread.status === 'canceled') {
        return { content: [{ type: 'text' as const,
          text: `error: thread is ${thread.status}. It has been resolved - do not reply. `
            + `If there is genuinely new work, open a new thread with the send tool.` }], isError: true }
      }

      // Priority gates (phase 06): same capability model as send.
      const caps = await getCapabilities(db, ctx.projectId, ctx.userId)
      let urgent: boolean
      try {
        urgent = resolveUrgent(caps, args.urgent)
      }
      catch (e) {
        if (e instanceof CapabilityError) {
          return { content: [{ type: 'text' as const,
            text: 'error: urgent capability not granted for this project. '
              + 'Ask a project manager to grant it, or resend without urgent.' }],
          isError: true }
        }
        throw e
      }
      const canFlagHuman = args.needsHuman === true && caps.has('needs_human')
      const humanIgnored = args.needsHuman === true && !canFlagHuman

      // Escalation: an agent with the needs_human capability can raise the human
      // flag on an existing thread. Self-assertion without the capability is blocked.
      if (canFlagHuman && !thread.tags.includes(NEEDS_HUMAN_TAG)) {
        await db.update(threads)
          .set({ tags: [...thread.tags, NEEDS_HUMAN_TAG] })
          .where(eq(threads.id, args.threadId))
      }

      const fromAgent = await touchAgent(db, ctx.projectId, ctx.part)
      const [proj] = await db.select({ cap: projects.maxBroadcastRecipients })
        .from(projects).where(eq(projects.id, ctx.projectId)).limit(1)

      // Feature-flag gate (12): same enforcement gate as send (reply goes through
      // the identical pipeline - spec 8 unified pipeline invariant).
      const enforce = await isWakeBudgetEnabled(db, { projectId: ctx.projectId })

      try {
        const r = await dispatch(db, {
          projectId: ctx.projectId,
          projectSlug: ctx.projectSlug,
          threadId: args.threadId,
          subject: thread.subject,
          fromPart: ctx.part,
          fromAgentId: fromAgent.id,
          fromUserId: ctx.userId,
          connectionId: ctx.connectionId,
          body: args.body,
          urgent, // phase 06: routes to the separate U lane in shouldWake/reserve
          recipientsSpec: { mode: 'reply', threadId: args.threadId },
          maxBroadcastRecipients: proj?.cap ?? null,
          enforce,
          emit: (part, messageId) => bus.emit('message', {
            kind: 'message',
            projectId: ctx.projectId,
            project: ctx.projectSlug,
            part,
            threadId: args.threadId,
            messageId,
            subject: thread.subject,
            fromPart: ctx.part,
          }),
        })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            messageId: r.messageId,
            ...(humanIgnored ? { humanFlagIgnored: 'needs_human capability missing; bell not lit' } : {}),
          }) }],
        }
      }
      catch (e) {
        if (e instanceof BroadcastCapError || e instanceof LoopBreakerError) {
          return { content: [{ type: 'text' as const, text: `error: ${e.message}` }], isError: true }
        }
        throw e
      }
    },
  )

  // ── inbox: list messages for this part ───────────────────────────────────

  mcp.tool(
    'inbox',
    'List messages addressed to this agent, newest first. Returns a short body '
      + 'preview per message; call `show` with the threadId to read full bodies. '
      + `Default ${INBOX_DEFAULT_LIMIT} most recent; pass unreadOnly: true for unread only.`,
    {
      unreadOnly: z.boolean().optional().describe('If true, return only unread messages'),
      limit: z.number().int().min(1).max(INBOX_MAX_LIMIT).optional()
        .describe(`Max messages to return (default ${INBOX_DEFAULT_LIMIT}, max ${INBOX_MAX_LIMIT})`),
    },
    async (args) => {
      const me = await touchAgent(db, ctx.projectId, ctx.part)
      const fromAgentsAlias = alias(agents, 'from_agents')
      // Closed/canceled threads are done - keep them out of the actionable inbox so
      // they are not re-read or re-acted. History is still reachable via show/threads.
      const conditions = [
        eq(messageRecipients.agentId, me.id),
        sql`${threads.status} not in ('closed','canceled')`,
      ]
      if (args.unreadOnly) conditions.push(isNull(messageRecipients.readAt))
      const limit = Math.min(args.limit ?? INBOX_DEFAULT_LIMIT, INBOX_MAX_LIMIT)
      const rows = await db.select({
        messageId: messages.id,
        threadId: threads.id,
        subject: threads.subject,
        from: fromAgentsAlias.part,
        body: messages.body,
        createdAt: messages.createdAt,
        readAt: messageRecipients.readAt,
      }).from(messageRecipients)
        .innerJoin(messages, eq(messageRecipients.messageId, messages.id))
        .innerJoin(threads, eq(messages.threadId, threads.id))
        .leftJoin(fromAgentsAlias, eq(messages.fromAgentId, fromAgentsAlias.id))
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt))
        .limit(limit)

      // Token-lean shape: preview instead of full body, unread flag instead of
      // a nullable timestamp. Full bodies come from `show`.
      const items = rows.map((r) => ({
        messageId: r.messageId,
        threadId: r.threadId,
        subject: r.subject,
        from: r.from,
        unread: r.readAt === null,
        at: r.createdAt,
        preview: preview(r.body),
      }))

      // The agent checked its inbox in response to a wake. If nothing unread remains
      // in an open thread, end the wake here too - this is what stopped the stuck
      // "empty inbox, same wake id forever" loop (the agent reads inbox, finds
      // nothing, and the wake is now satisfied).
      if (await openUnreadCount(db, me.id) === 0) await settleCaughtUp(db, me.id)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(items) }],
      }
    },
  )

  // ── ack: mark a message as read ──────────────────────────────────────────

  mcp.tool(
    'ack',
    'Mark a message as read for this agent.',
    {
      messageId: z.string().describe('UUID of the message to acknowledge'),
    },
    async (args) => {
      if (!isUuid(args.messageId)) {
        return { content: [{ type: 'text' as const, text: 'error: invalid messageId' }], isError: true }
      }
      const me = await touchAgent(db, ctx.projectId, ctx.part)
      const [updated] = await db.update(messageRecipients)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(messageRecipients.messageId, args.messageId),
            eq(messageRecipients.agentId, me.id),
            isNull(messageRecipients.readAt),
          ),
        )
        .returning()
      if (updated) {
        // Caught up? End the wake. This is the agent-driven completion the wake
        // lifecycle was missing - without it a delivered wake never settles and the
        // pager re-delivers it forever.
        if (await openUnreadCount(db, me.id) === 0) await settleCaughtUp(db, me.id)
        // Live read receipt: tell the dashboard this message was read so the thread view
        // refreshes without a manual reload. A 'read' kind (NOT 'message') so pagers
        // ignore it - they only wake on kind:'message'.
        bus.emit('message', {
          kind: 'read',
          projectId: ctx.projectId,
          project: ctx.projectSlug,
          part: ctx.part,
          messageId: args.messageId,
        })
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] }
      }
      // Check if it exists at all
      const [existing] = await db.select()
        .from(messageRecipients)
        .where(
          and(
            eq(messageRecipients.messageId, args.messageId),
            eq(messageRecipients.agentId, me.id),
          ),
        )
      if (!existing) {
        return { content: [{ type: 'text' as const, text: 'error: message not found in inbox' }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, alreadyRead: true }) }] }
    },
  )

  // ── event: record a work event ────────────────────────────────────────────

  mcp.tool(
    'event',
    'Record a work event for this agent (progress, complete, error, etc.).',
    {
      type: z.string().describe('Event type: spawn | progress | complete | error | message | composing | limited (rate-limit park: set detail.resetAt to the ISO time your provider limit lifts; omit/null to clear)'),
      detail: z.record(z.string(), z.unknown()).optional().describe('Structured detail payload'),
      usage: z.object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_tokens: z.number().optional(),
        model: z.string().optional(),
        cost_usd: z.number().optional(),
      }).optional().describe('Token usage stats'),
      parentEventId: z.string().optional().describe('Parent event UUID for hierarchical events'),
      spawnedAgentLabel: z.string().optional().describe('Label of a spawned sub-agent'),
      startedAt: z.string().optional().describe('ISO timestamp when work started'),
      endedAt: z.string().optional().describe('ISO timestamp when work ended'),
    },
    async (args) => {
      // Scope-check parentEventId: it must be a UUID belonging to THIS project,
      // otherwise an agent could link its events under another tenant's event.
      let parentEventId: string | null = null
      if (args.parentEventId != null) {
        if (!isUuid(args.parentEventId)) {
          return { content: [{ type: 'text' as const, text: 'error: invalid parentEventId' }], isError: true }
        }
        const [parent] = await db.select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, args.parentEventId), eq(events.projectId, ctx.projectId)))
          .limit(1)
        if (!parent) {
          return { content: [{ type: 'text' as const, text: 'error: parentEventId not in your project' }], isError: true }
        }
        parentEventId = parent.id
      }

      const agent = await touchAgent(db, ctx.projectId, ctx.part)
      const [event] = await db.insert(events).values({
        projectId: ctx.projectId,
        agentId: agent.id,
        type: args.type,
        detail: args.detail ?? {},
        usage: args.usage ?? null,
        parentEventId,
        spawnedAgentLabel: args.spawnedAgentLabel ?? null,
        startedAt: toDate(args.startedAt),
        endedAt: toDate(args.endedAt),
      }).returning()

      // Live "typing" indicator: a composing event carries a threadId in its detail;
      // publish a transient 'composing' bus event so the dashboard thread view lights
      // up "작성 중" for this part. A 'composing' kind (NOT 'message') so pagers ignore
      // it (they only wake on kind:'message'). Best-effort: no threadId -> no signal.
      if (args.type === 'composing' && typeof args.detail?.threadId === 'string') {
        bus.emit('message', {
          kind: 'composing',
          projectId: ctx.projectId,
          project: ctx.projectSlug,
          part: ctx.part,
          threadId: args.detail.threadId,
        })
      }

      // Provider rate-limit park (limit-aware wake). An agent that hits (or is
      // about to hit) its provider's usage limit reports type:'limited' with
      // detail.resetAt (ISO timestamp the limit lifts). While parked, wake
      // issuance is suppressed for this agent (issuance.ts gate 2.5); the 30s
      // eligibility sweep resumes it on its first tick past resetAt. Delivery is
      // unaffected - messages queue in the inbox. detail.resetAt null/absent (or
      // a past timestamp) CLEARS the park ("I'm back early"). An agent can only
      // park ITSELF (ctx.part), and the window is clamped to 24h so a bogus
      // report cannot silence a part indefinitely.
      if (args.type === 'limited') {
        const raw = args.detail?.resetAt
        let limitedUntil: Date | null = null
        if (typeof raw === 'string') {
          const parsed = new Date(raw)
          if (Number.isNaN(parsed.getTime())) {
            return { content: [{ type: 'text' as const, text: 'error: detail.resetAt is not a valid ISO timestamp' }], isError: true }
          }
          const maxUntil = Date.now() + 24 * 60 * 60 * 1000
          if (parsed.getTime() > Date.now()) {
            limitedUntil = parsed.getTime() > maxUntil ? new Date(maxUntil) : parsed
          }
          // past timestamp -> treated as a clear (limitedUntil stays null)
        }
        await db.update(agents)
          .set({ limitedUntil })
          .where(eq(agents.id, agent.id))
        // Live badge for the dashboard. A 'limited' kind (NOT 'message') so pagers
        // ignore it (they only wake on kind:'message').
        bus.emit('message', {
          kind: 'limited',
          projectId: ctx.projectId,
          project: ctx.projectSlug,
          part: ctx.part,
          limitedUntil: limitedUntil ? limitedUntil.toISOString() : null,
        })
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ eventId: event.id }) }],
      }
    },
  )

  // ── threads: list threads in this project ────────────────────────────────

  mcp.tool(
    'threads',
    'List threads in this project.',
    {
      status: z.enum(['open', 'answered', 'closed', 'holding', 'canceled']).optional()
        .describe('Filter by thread status'),
      q: z.string().optional().describe('Filter by subject substring (case-insensitive)'),
    },
    async (args) => {
      const conditions = [eq(threads.projectId, ctx.projectId)]
      if (args.status) conditions.push(eq(threads.status, args.status))
      // Push the subject filter into SQL (ilike) so the limit applies AFTER
      // matching — an in-memory filter on the first 50 rows can miss matches.
      if (args.q) conditions.push(ilike(threads.subject, `%${args.q}%`))

      const rows = await db.select({
        id: threads.id,
        subject: threads.subject,
        status: threads.status,
        createdAt: threads.createdAt,
      })
        .from(threads)
        .where(and(...conditions))
        .orderBy(desc(threads.createdAt))
        .limit(50)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows) }],
      }
    },
  )

  // ── show: read a specific thread with its messages ────────────────────────

  mcp.tool(
    'show',
    'Read a specific thread and all its messages.',
    {
      threadId: z.string().describe('UUID of the thread to read'),
    },
    async (args) => {
      if (!isUuid(args.threadId)) {
        return { content: [{ type: 'text' as const, text: 'error: invalid threadId' }], isError: true }
      }
      // Project only agent-facing columns (the bare SELECT * shipped internal
      // fields like projectId/updatedAt the agent never reads — wasted tokens).
      const [thread] = await db.select({
        id: threads.id,
        subject: threads.subject,
        status: threads.status,
        createdAt: threads.createdAt,
        projectId: threads.projectId,
      }).from(threads).where(eq(threads.id, args.threadId))
      if (!thread || thread.projectId !== ctx.projectId) {
        return { content: [{ type: 'text' as const, text: 'error: thread not found' }], isError: true }
      }
      const fromAgentsAlias = alias(agents, 'from_agents')
      const msgs = await db.select({
        id: messages.id,
        body: messages.body,
        from: fromAgentsAlias.part,
        createdAt: messages.createdAt,
      }).from(messages)
        .leftJoin(fromAgentsAlias, eq(messages.fromAgentId, fromAgentsAlias.id))
        .where(eq(messages.threadId, args.threadId))
        .orderBy(asc(messages.createdAt))

      // Drop the internal projectId from the agent-facing payload.
      const threadOut = {
        id: thread.id,
        subject: thread.subject,
        status: thread.status,
        createdAt: thread.createdAt,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ thread: threadOut, messages: msgs }) }],
      }
    },
  )

  // ── close: end a thread so it stops waking anyone ────────────────────────────

  mcp.tool(
    'close',
    'Close a thread once it is resolved (a question answered, a task acknowledged). A closed thread '
      + 'leaves every inbox and NEVER wakes its participants again - this is how you end a conversation. '
      + 'Close early and often; an open thread keeps pinging. If there is genuinely new work, open a new '
      + 'thread with send instead of reopening.',
    {
      threadId: z.string().describe('UUID of the thread to close'),
    },
    async (args) => {
      if (!isUuid(args.threadId)) {
        return { content: [{ type: 'text' as const, text: 'error: invalid threadId' }], isError: true }
      }
      const [thread] = await db.select({ id: threads.id, projectId: threads.projectId, status: threads.status })
        .from(threads).where(eq(threads.id, args.threadId)).limit(1)
      if (!thread || thread.projectId !== ctx.projectId) {
        return { content: [{ type: 'text' as const, text: 'error: thread not found' }], isError: true }
      }
      if (thread.status !== 'closed' && thread.status !== 'canceled') {
        await db.update(threads).set({ status: 'closed' }).where(eq(threads.id, args.threadId))
        // Recipients who still had unread in this thread - they may now be caught up.
        const affected = await db.selectDistinct({ agentId: messageRecipients.agentId })
          .from(messageRecipients)
          .innerJoin(messages, eq(messageRecipients.messageId, messages.id))
          .where(and(eq(messages.threadId, args.threadId), isNull(messageRecipients.readAt)))
        // Clear unread for this thread. CRITICAL: inbox/sweep already hide closed
        // threads, but the pending-wake (pager catch-up) path counts raw unread - so
        // an unread left in a closed thread woke the agent forever (inbox returned []
        // since it hides closed, the agent could never ack it). Marking read here
        // zeroes the unread so no wake path can re-fire for a resolved conversation.
        await db.update(messageRecipients).set({ readAt: new Date() })
          .where(and(
            isNull(messageRecipients.readAt),
            sql`${messageRecipients.messageId} in (select id from ${messages} where thread_id = ${args.threadId})`,
          ))
        // Settle each affected agent whose open-unread just hit 0 - otherwise their
        // active wake lingers (consuming budget + holding the lease) until it expires.
        for (const a of affected) {
          if (await openUnreadCount(db, a.agentId) === 0) await settleCaughtUp(db, a.agentId)
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, threadId: thread.id, status: 'closed' }) }] }
    },
  )

  // ── search: find threads you are not a participant in ────────────────────────

  mcp.tool(
    'search',
    'Search threads in this project by subject and message body (case-insensitive substring). Use this '
      + 'to pull context from conversations you are NOT part of - so you can keep working without being '
      + 'sent everything. Returns matching threads (id, subject, status); call show for full content.',
    {
      query: z.string().min(1).max(200).describe('Text to look for in thread subjects and message bodies'),
      limit: z.number().int().min(1).max(20).optional().describe('Max threads to return (default 10, max 20)'),
    },
    async (args) => {
      const limit = Math.min(args.limit ?? 10, 20)
      const like = `%${args.query.replace(/[%_\\]/g, (m) => '\\' + m)}%`
      // Body matches are an EXISTS, not a join. A join produces one row per matching
      // message, which needed DISTINCT ON (thread.id) to collapse - and DISTINCT ON
      // forces ORDER BY to lead with thread.id. Ids are uuidv7, so that ordering is
      // oldest-first, and the limit then kept the OLDEST matches and dropped every
      // recent one. A search for something discussed today returned nothing from
      // today. EXISTS yields at most one row per thread, which frees the ORDER BY to
      // be what the caller wants: newest first, matching the `threads` tool.
      const rows = await db.select({
        threadId: threads.id,
        subject: threads.subject,
        status: threads.status,
        createdAt: threads.createdAt,
      }).from(threads)
        .where(and(
          eq(threads.projectId, ctx.projectId),
          sql`(${threads.subject} ilike ${like} or exists (
            select 1 from ${messages}
            where thread_id = ${threads.id} and body ilike ${like}
          ))`,
        ))
        .orderBy(desc(threads.createdAt))
        .limit(limit)
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] }
    },
  )

  // ── roster: who is in this project (so you know who to address) ───────────

  mcp.tool(
    'roster',
    'List the agents (parts) in this project and whether each is online, so you know who to '
    + 'send/reply to. `send`/`reply` address parts - this is how you discover them.',
    {},
    async () => {
      const rows = await db
        .select({
          part: agents.part,
          role: agents.role,
          nickname: agents.nickname,
          lastSeenAt: agents.lastSeenAt,
          connected: sql<number>`count(${agentConnections.id}) filter (where ${agentConnections.status} = 'connected')`,
        })
        .from(agents)
        .leftJoin(agentConnections, eq(agentConnections.agentId, agents.id))
        .where(and(eq(agents.projectId, ctx.projectId), isNull(agents.deletedAt)))
        .groupBy(agents.id)
        .orderBy(asc(agents.part))

      const roster = rows.map(r => ({
        part: r.part,
        isMain: r.role === 'main',
        nickname: r.nickname ?? undefined,
        online: Number(r.connected) > 0,
        lastSeen: r.lastSeenAt,
        you: r.part === ctx.part,
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(roster) }] }
    },
  )

  // ── whoami: this agent's own identity in the project ──────────────────────

  mcp.tool(
    'whoami',
    "Report this agent's own part, project, and whether it is the main agent - useful after a "
    + 'compaction or restart to re-orient.',
    {},
    async () => {
      const [me] = await db
        .select({ role: agents.role, nickname: agents.nickname })
        .from(agents)
        .where(and(
          eq(agents.projectId, ctx.projectId),
          eq(agents.part, ctx.part),
          isNull(agents.deletedAt),
        ))
        .limit(1)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          part: ctx.part,
          project: ctx.projectSlug,
          isMain: me?.role === 'main',
          nickname: me?.nickname ?? undefined,
        }) }],
      }
    },
  )

  return mcp
}

// ── WWW-Authenticate helper ───────────────────────────────────────────────────

/**
 * Returns the WWW-Authenticate header value pointing to the protected resource
 * metadata document so MCP clients can discover the auth server.
 */
function wwwAuthenticateHeader(serverBase: string): string {
  const metadataUrl = `${serverBase}/.well-known/oauth-protected-resource`
  return `Bearer realm="relayroom", resource_metadata="${metadataUrl}"`
}

/**
 * Recursively reduce a JSON Schema to the OpenAPI-3.0 subset that function-calling
 * MCP clients accept. The MCP SDK's zod-to-json-schema emits draft-07 keywords
 * (`$schema`, `propertyNames`, `additionalProperties`, `exclusive(Min|Max)imum`)
 * that strict clients (e.g. Gemini CLI) reject outright. This is NOT a per-client
 * workaround - it normalizes the advertised schema for EVERYONE. Server-side zod
 * validation is unaffected (it runs on the parsed args, not this advertised shape).
 */
// Parse a client-supplied ISO timestamp DEFENSIVELY: an invalid string would become
// `Invalid Date` and throw a 500 at DB serialization. Returns null on anything not a
// valid date, so a bad timestamp is dropped rather than crashing the request.
function toDate(s: unknown): Date | null {
  if (typeof s !== 'string' || !s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function cleanJsonSchema(node: unknown): void {
  if (Array.isArray(node)) {
    for (const v of node) cleanJsonSchema(v)
    return
  }
  if (!node || typeof node !== 'object') return
  const o = node as Record<string, unknown>
  delete o['$schema']
  delete o['propertyNames']
  delete o['additionalProperties']
  delete o['patternProperties']
  // Strict clients (Gemini) reject draft-07 exclusive bounds. Translate WITHOUT
  // weakening: for integers, `> X` is exactly `>= X+1` (and `< X` is `<= X-1`); for
  // non-integers there is no exact inclusive equivalent, so drop the keyword rather
  // than advertise a wrong inclusive bound (the server's zod still enforces the real
  // constraint - the JSON Schema is only a hint to the client).
  const isInt = o['type'] === 'integer'
  if ('exclusiveMinimum' in o) {
    // Smallest integer strictly greater than X is floor(X)+1 (handles non-integer
    // bounds like 1.5 -> 2; for an integer X it is X+1). Keep the STRONGER bound if a
    // plain `minimum` already exists.
    if (isInt && typeof o['exclusiveMinimum'] === 'number') {
      const m = Math.floor(o['exclusiveMinimum']) + 1
      o['minimum'] = typeof o['minimum'] === 'number' ? Math.max(o['minimum'], m) : m
    }
    delete o['exclusiveMinimum']
  }
  if ('exclusiveMaximum' in o) {
    if (isInt && typeof o['exclusiveMaximum'] === 'number') {
      const m = Math.ceil(o['exclusiveMaximum']) - 1
      o['maximum'] = typeof o['maximum'] === 'number' ? Math.min(o['maximum'], m) : m
    }
    delete o['exclusiveMaximum']
  }
  for (const v of Object.values(o)) cleanJsonSchema(v)
}

/**
 * Normalize a tools/list JSON-RPC reply in-place (handles both plain-JSON and the
 * SSE "data: {...}" framing the streamable-HTTP transport uses). Leaves any other
 * reply untouched. Returns the (possibly rewritten) body text.
 */
function normalizeToolSchemas(raw: string): string {
  const rewrite = (jsonText: string): string => {
    let msg: { result?: { tools?: Array<{ inputSchema?: unknown }> } }
    try { msg = JSON.parse(jsonText) } catch { return jsonText }
    const tools = msg?.result?.tools
    if (!Array.isArray(tools)) return jsonText
    for (const t of tools) if (t.inputSchema) cleanJsonSchema(t.inputSchema)
    return JSON.stringify(msg)
  }
  if (raw.startsWith('data:') || raw.includes('\ndata:')) {
    return raw
      .split('\n')
      .map((line) => (line.startsWith('data:') ? 'data: ' + rewrite(line.slice(line.indexOf(':') + 1).trim()) : line))
      .join('\n')
  }
  return rewrite(raw)
}

/** Count an agent's unread messages that still live in an OPEN thread. Closed/
 *  canceled threads are resolved, so their unread must not keep a wake alive. */
async function openUnreadCount(db: Db, agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messageRecipients)
    .innerJoin(messages, eq(messageRecipients.messageId, messages.id))
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(and(
      eq(messageRecipients.agentId, agentId),
      isNull(messageRecipients.readAt),
      sql`${threads.status} not in ('closed','canceled')`,
    ))
  return row?.n ?? 0
}

// ── RELAYROOM.md "Current main agent" section ─────────────────────────────────

/**
 * Renders a short "## Current main agent" section appended to the served
 * RELAYROOM.md, listing each owner's current main part. So any worktree
 * re-pulling RELAYROOM.md sees who the main is. Best-effort: on any failure it
 * returns an empty string so the base markdown is still served.
 */
async function renderCurrentMainSection(db: Db, projectId: string): Promise<string> {
  try {
    const rows = await db
      .select({
        part: agents.part,
        name: authSchema.better_auth_user.name,
        nickname: authSchema.better_auth_user.nickname,
      })
      .from(agents)
      .leftJoin(authSchema.better_auth_user, eq(agents.ownerUserId, authSchema.better_auth_user.id))
      .where(and(eq(agents.projectId, projectId), eq(agents.role, 'main'), isNull(agents.deletedAt)))
      .orderBy(asc(agents.part))

    const header = '\n## Current main agent\n\n'
    if (rows.length === 0) {
      return `${header}none set yet\n`
    }
    const lines = rows
      .map((r) => {
        const owner = (r.nickname || r.name) ?? 'unknown'
        return `- owner ${owner} -> main part ${r.part}`
      })
      .join('\n')
    return `${header}${lines}\n`
  }
  catch (err) {
    console.error('[relayroom-md] current main section failed', err)
    return ''
  }
}

// ── CLI update check (npm registry, cached) ─────────────────────────────────
// The pager reports its CLI version on each heartbeat; we hand back the latest
// version published to npm so the tmux status line can nudge for an update. npm
// (not the GitHub release) is the source of truth: an npm publish can lag the
// release, and nudging to a version that is not yet installable would be wrong.
// Cached in-memory (one registry call serves every agent) and refreshed in the
// background so the heartbeat response never blocks on the network.
// `at` = last SUCCESSFUL fetch (gates the 1h TTL); `lastAttempt` = last try (gates
// the retry backoff). Splitting them means a failed/cold-start fetch keeps `version`
// stale and retries after a short backoff instead of going silent for the full TTL.
let cliLatestCache: { version: string | null; at: number; lastAttempt: number } = { version: null, at: 0, lastAttempt: 0 }
let cliLatestRefreshing = false
const CLI_LATEST_TTL_MS = 60 * 60 * 1000 // 1h between successful refreshes
const CLI_LATEST_RETRY_MS = 2 * 60 * 1000 // min spacing between attempts (failure backoff)

function latestCliVersion(): string | null {
  const now = Date.now()
  const stale = now - cliLatestCache.at >= CLI_LATEST_TTL_MS
  const mayRetry = now - cliLatestCache.lastAttempt >= CLI_LATEST_RETRY_MS
  if (stale && mayRetry && !cliLatestRefreshing) {
    cliLatestRefreshing = true
    cliLatestCache = { ...cliLatestCache, lastAttempt: now } // claim the slot to avoid a stampede
    void (async () => {
      try {
        const res = await fetch('https://registry.npmjs.org/@relayroom/cli/latest', {
          signal: AbortSignal.timeout(4000),
        })
        if (res.ok) {
          const json = (await res.json()) as { version?: unknown }
          // Only a valid version advances `at` (the success TTL); a failure leaves
          // it stale so the next beat past the backoff retries.
          if (typeof json.version === 'string') cliLatestCache = { ...cliLatestCache, version: json.version, at: Date.now() }
        }
      } catch {
        /* keep the last known good value; lastAttempt spaces the retry */
      } finally {
        cliLatestRefreshing = false
      }
    })()
  }
  return cliLatestCache.version
}

/** True when `latest` is a higher version than `current`. Numeric x.y.z, with a
 *  minimal prerelease rule: same x.y.z, a release (no `-tag`) beats a prerelease. */
function isCliOutdated(current: string, latest: string): boolean {
  const split = (v: string) => {
    const clean = v.replace(/^v/, '')
    const dash = clean.indexOf('-')
    const base = dash === -1 ? clean : clean.slice(0, dash)
    const pre = dash === -1 ? '' : clean.slice(dash + 1)
    const [a = 0, b = 0, c = 0] = base.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { a, b, c, pre }
  }
  const cur = split(current)
  const lat = split(latest)
  if (lat.a !== cur.a) return lat.a > cur.a
  if (lat.b !== cur.b) return lat.b > cur.b
  if (lat.c !== cur.c) return lat.c > cur.c
  // Same x.y.z: a prerelease is older than its final release.
  if (cur.pre && !lat.pre) return true
  if (!cur.pre && lat.pre) return false
  return lat.pre > cur.pre // both prereleases (or both none) -> lexical
}

// ── Hono route factory ────────────────────────────────────────────────────────

export function createMcpRoute(db: Db, bus: Bus) {
  const route = new Hono()

  // DNS-rebinding defense: reject requests whose Host header is not an expected
  // host for this server. Applies to every /mcp/* endpoint (transport, heartbeat,
  // wake, usage). Skipped only when the Host header is absent (non-browser tooling
  // that omits it) — the bearer/connect-code checks still gate those.
  const envHosts = getAllowedMcpHosts()
  route.use('*', async (c, next) => {
    const host = c.req.header('Host')
    if (host) {
      const hostname = host.split(':')[0] ?? host
      // Allow env-configured hosts plus the dashboard-set public server base
      // (Settings -> Environment), so a domain configured only in the UI is not
      // shown in the connect guide yet rejected here. DB host is cached (TTL).
      const allowed = new Set(envHosts)
      const dbHost = await getConfiguredServerHost(db)
      if (dbHost) allowed.add(dbHost)
      if (allowed.size > 0 && !allowed.has(hostname)) {
        return c.json({ error: 'host not allowed' }, 403)
      }
    }
    return next()
  })

  // ── Usage ingest (agent telemetry) ────────────────────────────────────────
  // The Claude Code Stop hook reports a turn's token usage here. Authenticated
  // by the connect_code capability (the same key the agent + pager already
  // hold) — kept cheap on purpose; tighten to the OAuth bearer later if needed.
  // This is NOT the MCP transport path (that is POST /:connectCode below).
  const usageInput = z.object({
    part: z.string().min(1).max(32),
    type: z.string().optional(),
    usage: z.object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_tokens: z.number().optional(),
      cost_usd: z.number().optional(),
      model: z.string().optional(),
    }),
    detail: z.record(z.string(), z.unknown()).optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
  })

  route.post('/:connectCode/usage', async (c) => {
    const connectCode = c.req.param('connectCode')
    const body = await c.req.json().catch(() => null)
    const parsed = usageInput.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400)
    }
    const { part, type, usage, detail, startedAt, endedAt } = parsed.data
    if (!isValidPart(part)) {
      return c.json({ error: 'invalid part' }, 400)
    }

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.connectCode, connectCode), isNull(projects.archivedAt)))
      .limit(1)
    if (!project) return c.json({ error: 'unknown connect code' }, 404)

    // Resolve the agent FIRST (before the empty-usage shortcut) so an unregistered
    // part gets a consistent 404 either way. Usage ingest must NOT create agents
    // (web-UI-only invariant, same as heartbeat): a connect-code holder posting usage
    // for an arbitrary slug would otherwise conjure a phantom agent.
    const agent = await touchAgent(db, project.id, part)
    if (!agent) return c.json({ error: 'agent not registered' }, 404)

    // Nothing to record if the turn used no tokens.
    const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_tokens ?? 0)
    if (total <= 0) return c.json({ ok: true, skipped: 'empty usage' })
    const [event] = await db
      .insert(events)
      .values({
        projectId: project.id,
        agentId: agent.id,
        type: type ?? 'complete',
        detail: detail ?? {},
        usage,
        startedAt: toDate(startedAt),
        endedAt: toDate(endedAt),
      })
      .returning({ id: events.id })

    return c.json({ ok: true, eventId: event?.id })
  })

  // RELAYROOM.md for this project, fetched by `relayroom init` on the agent side.
  // Connect-code scoped (same trust model as /usage); returns the dashboard-edited
  // content, or the default template when unset.
  route.get('/:connectCode/relayroom-md', async (c) => {
    const connectCode = c.req.param('connectCode')
    const [project] = await db
      .select({ id: projects.id, slug: projects.slug, relayroomMd: projects.relayroomMd })
      .from(projects)
      .where(and(eq(projects.connectCode, connectCode), isNull(projects.archivedAt)))
      .limit(1)
    if (!project) return c.json({ error: 'unknown connect code' }, 404)

    const base = project.relayroomMd ?? DEFAULT_RELAYROOM_MD
    const md = base + (await renderCurrentMainSection(db, project.id))
    // Expose the project slug so `relayroom init` can name the tmux session
    // deterministically (RR-<slug>-<part>) without a second round trip.
    return c.text(md, 200, {
      'content-type': 'text/markdown; charset=utf-8',
      'x-relayroom-project-slug': project.slug,
    })
  })

  // Authoritative role lookup (read-only). The Claude AskUserQuestion guard calls
  // this before ever blocking, so it never relies on a possibly-stale local cache:
  // a non-main agent is only blocked on a live `default` answer here.
  route.get('/:connectCode/role', async (c) => {
    const connectCode = c.req.param('connectCode')
    const part = c.req.query('part') ?? ''
    if (!isValidPart(part)) return c.json({ error: 'invalid part' }, 400)
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.connectCode, connectCode), isNull(projects.archivedAt)))
      .limit(1)
    if (!project) return c.json({ error: 'unknown connect code' }, 404)
    const [agent] = await db
      .select({ role: agents.role })
      .from(agents)
      .where(and(eq(agents.projectId, project.id), eq(agents.part, part), isNull(agents.deletedAt)))
      .limit(1)
    if (!agent) return c.json({ error: 'agent not registered' }, 404)
    return c.json({ role: agent.role })
  })

  // Pager heartbeat: keeps the agent's last-seen fresh and reports whether
  // RELAYROOM.md is present in its worktree (for the dashboard sync indicator).
  route.post('/:connectCode/heartbeat', async (c) => {
    const connectCode = c.req.param('connectCode')
    const body = await c.req.json().catch(() => null) as
      { part?: unknown; relayroomMd?: unknown; holder?: unknown; release?: unknown; host?: unknown; version?: unknown } | null
    const part = typeof body?.part === 'string' ? body.part : ''
    if (!isValidPart(part)) return c.json({ error: 'invalid part' }, 400)
    const holder = typeof body?.holder === 'string' ? body.holder : null
    const host = typeof body?.host === 'string' && body.host.trim() ? body.host.trim().slice(0, 200) : null

    const [project] = await db
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(and(eq(projects.connectCode, connectCode), isNull(projects.archivedAt)))
      .limit(1)
    if (!project) return c.json({ error: 'unknown connect code' }, 404)

    // Heartbeat must not create agents (web-UI-only invariant). A pager pointed at
    // an unregistered part is rejected rather than conjuring a phantom agent.
    const agent = await touchAgent(db, project.id, part)
    if (!agent) return c.json({ error: 'agent not registered' }, 404)
    // The heartbeat is the pager's liveness signal - record it on every beat so
    // the UI can tell the pager is alive independent of the agent's own activity.
    const agentUpdate: { pagerLastSeenAt: Date; relayroomMdSyncedAt?: Date | null } = {
      pagerLastSeenAt: new Date(),
    }
    if (typeof body?.relayroomMd === 'boolean') {
      agentUpdate.relayroomMdSyncedAt = body.relayroomMd ? new Date() : null
    }
    await db.update(agents).set(agentUpdate).where(eq(agents.id, agent.id))

    // Broadcast the beat so dashboards flip the agent's pager indicator to online
    // live (and the connect dialog can confirm + close). Fires every beat so the
    // client's last-seen stays fresh; the client downgrades to offline on a gap.
    bus.emit('message', {
      kind: 'pager',
      projectId: project.id,
      project: project.slug,
      agentId: agent.id,
      part,
      online: true,
    })

    // Auto-fill the machine label from the reporting machine's hostname. Only set it
    // when unset, so an explicit user override is never clobbered.
    if (host) {
      const [conn] = await db
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .where(and(eq(agentConnections.agentId, agent.id), isNull(agentConnections.machineLabel)))
        .orderBy(desc(agentConnections.connectedAt))
        .limit(1)
      if (conn) {
        await db.update(agentConnections).set({ machineLabel: host }).where(eq(agentConnections.id, conn.id))
      }
    }

    // Lease release on shutdown (best-effort; TTL backstops a failed call).
    if (holder && body?.release === true) {
      await releaseLease(db, { agentId: agent.id, holder })
      return c.json({ ok: true, released: true })
    }

    // Lease renew (07): a pager carrying its holder id extends its lease. leaseHeld
    // tells the pager whether it still owns the part (false => another pager took
    // over, stop nudging). Only meaningful when there is an active wake.
    let leaseHeld = false
    if (holder) {
      const r = await renewLease(db, { agentId: agent.id, holder })
      leaseHeld = r.ok
    }

    // Eligibility trigger (05): if this idle part has pending unread and budget is
    // now available, re-issue its suppressed wake. Fire-and-forget so the heartbeat
    // response is not delayed; shouldWake coalesces so this is safe to run often.
    void runEligibilitySweep(db, bus, { agentId: agent.id }).catch(e =>
      console.error('[wake] heartbeat sweep failed', e),
    )
    // Tell the pager the latest CLI on npm (vs the version it reported) so the
    // tmux status line can nudge for an update. Best-effort + cached; absent when
    // the pager did not send its version or the registry is unreachable.
    const reportedVersion = typeof body?.version === 'string' ? body.version : null
    const latestCli = reportedVersion ? latestCliVersion() : null
    const updateAvailable = !!reportedVersion && !!latestCli && isCliOutdated(reportedVersion, latestCli)

    // Hand the agent's color (hex) back so the pager can cache it for the tmux
    // status line - matches the color shown for this agent in the dashboard.
    return c.json({ ok: true, leaseHeld, color: resolveAgentColorHex(agent.color, part), latestCli, updateAvailable, role: agent.role })
  })

  // ── Pager lease + fencing + catch-up (07) ──────────────────────────────────
  // Server-authoritative per-part lease replacing the pager's machine-local lock.
  // All three endpoints use the connect-code trust model (same as /heartbeat).

  /** Resolve the agent row for a connect-code + part, or null. Does NOT create. */
  async function resolveAgentByCode(connectCode: string, part: string) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.connectCode, connectCode), isNull(projects.archivedAt)))
      .limit(1)
    if (!project) return null
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, project.id), eq(agents.part, part)))
      .limit(1)
    return agent ?? null
  }

  /** Adapt 05's budget-aware shouldWake into the decidePendingWake issue contract. */
  async function issueCatchupWake(agentId: string): Promise<IssueResult> {
    const decision = await shouldWake(db, agentId, { reason: 'catchup' })
    if (decision.action === 'issue') return { wakeId: decision.wakeId }
    return { suppressed: true }
  }

  // Claim/take over the per-part lease for the active wake.
  route.post('/:connectCode/wake/claim', async (c) => {
    const connectCode = c.req.param('connectCode')
    const body = await c.req.json().catch(() => null) as { part?: unknown; holder?: unknown } | null
    const part = typeof body?.part === 'string' ? body.part : ''
    const holder = typeof body?.holder === 'string' ? body.holder : ''
    if (!isValidPart(part)) return c.json({ error: 'invalid part' }, 400)
    if (!holder) return c.json({ error: 'holder required' }, 400)

    const agent = await resolveAgentByCode(connectCode, part)
    if (!agent) return c.json({ ok: false, noWake: true })

    const r = await claimLease(db, { agentId: agent.id, holder })
    return c.json(r)
  })

  // Fencing: report that the pager nudged with a wakeId. Only the lease holder may
  // drive the pending->delivered transition; a stale wakeId is ignored.
  route.post('/:connectCode/wake/delivered', async (c) => {
    const connectCode = c.req.param('connectCode')
    const body = await c.req.json().catch(() => null) as
      { part?: unknown; wakeId?: unknown; holder?: unknown } | null
    const part = typeof body?.part === 'string' ? body.part : ''
    const wakeId = typeof body?.wakeId === 'string' ? body.wakeId : ''
    const holder = typeof body?.holder === 'string' ? body.holder : ''
    if (!isValidPart(part)) return c.json({ error: 'invalid part' }, 400)
    if (!wakeId || !holder) return c.json({ error: 'wakeId and holder required' }, 400)

    const agent = await resolveAgentByCode(connectCode, part)
    if (!agent) return c.json({ ok: false, stale: true })

    // Only the current lease holder may report delivery (a pager without the lease
    // must not drive fencing). Renew confirms holder + that an active wake exists.
    const lease = await renewLease(db, { agentId: agent.id, holder })
    if (!lease.ok) return c.json({ ok: false, notHolder: true })

    const r = await markDeliveredFenced(db, { agentId: agent.id, wakeId })
    return c.json(r)
  })

  // Catch-up: a SINGLE coalesced wake decision (replaces per-unread-item nudging).
  route.get('/:connectCode/pending-wake', async (c) => {
    const connectCode = c.req.param('connectCode')
    const part = c.req.query('part') ?? ''
    const holder = c.req.query('holder') ?? ''
    if (!isValidPart(part)) return c.json({ error: 'invalid part' }, 400)

    const agent = await resolveAgentByCode(connectCode, part)
    if (!agent) return c.json({ wake: false })

    const decision = await decidePendingWake(db, { agentId: agent.id, issue: issueCatchupWake })

    // If a wake exists and the caller named a holder, claim the lease so the
    // catch-up nudge it is about to send is fenced to a single pager.
    if (decision.wake && holder) {
      await claimLease(db, { agentId: agent.id, holder })
    }
    return c.json(decision)
  })

  // Unread messages addressed to a part. NOTE (07): the pager no longer uses this
  // for catch-up — catch-up is now the single coalesced decision in /pending-wake.
  // This endpoint is kept for diagnostics / dashboard / backward compatibility.
  // Read-only; same connect-code trust model as /usage and /heartbeat. Does NOT
  // create an agent — an unknown part has nothing unread by definition.
  route.get('/:connectCode/unread', async (c) => {
    const connectCode = c.req.param('connectCode')
    const part = c.req.query('part') ?? ''
    if (!isValidPart(part)) return c.json({ error: 'invalid part' }, 400)

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.connectCode, connectCode), isNull(projects.archivedAt)))
      .limit(1)
    if (!project) return c.json({ error: 'unknown connect code' }, 404)

    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, project.id), eq(agents.part, part)))
      .limit(1)
    if (!agent) return c.json({ count: 0, items: [] })

    const fromAgentsAlias = alias(agents, 'from_agents')
    const rows = await db.select({
      messageId: messages.id,
      threadId: threads.id,
      subject: threads.subject,
      from: fromAgentsAlias.part,
      createdAt: messages.createdAt,
    }).from(messageRecipients)
      .innerJoin(messages, eq(messageRecipients.messageId, messages.id))
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .leftJoin(fromAgentsAlias, eq(messages.fromAgentId, fromAgentsAlias.id))
      .where(and(
        eq(messageRecipients.agentId, agent.id),
        isNull(messageRecipients.readAt),
        sql`${threads.status} not in ('closed','canceled')`,
      ))
      .orderBy(desc(messages.createdAt))
      .limit(INBOX_MAX_LIMIT)

    return c.json({
      count: rows.length,
      items: rows.map((r) => ({
        messageId: r.messageId,
        threadId: r.threadId,
        subject: r.subject,
        fromPart: r.from,
        at: r.createdAt,
      })),
    })
  })

  route.all('/:connectCode', async (c) => {
    const connectCode = c.req.param('connectCode')
    const serverBase = getServerBase()

    // This MCP endpoint is STATELESS (sessionIdGenerator: undefined): the only
    // supported method is POST (request -> response). A GET opens the server->client
    // SSE stream, which a stateless transport holds open with no data - and the
    // handler below buffers the body via `.text()`, so a GET hangs forever. Some
    // clients (e.g. Antigravity CLI / agy) open that GET during initialization and
    // then wait on it, stalling at "initializing...". RelayRoom delivers wakes via
    // the pager / Claude Channels, not the MCP server->client stream, so reject every
    // non-POST method with 405 (spec-compliant: the server may decline GET/DELETE).
    if (c.req.method !== 'POST') {
      return c.text('Method Not Allowed', 405, { Allow: 'POST' })
    }

    // Extract bearer token — auth is ALWAYS required on /mcp
    const authHeader = c.req.header('Authorization') ?? ''
    const tokenMatch = /^Bearer (.+)$/i.exec(authHeader)
    const token = tokenMatch ? (tokenMatch[1] ?? null) : null

    if (!token) {
      return c.json(
        { error: 'agent bearer token required' },
        401,
        { 'WWW-Authenticate': wwwAuthenticateHeader(serverBase) },
      )
    }

    // Resolve part from query param (default: 'agent'); validate slug shape.
    const part = c.req.query('part') ?? 'agent'
    if (!isValidPart(part)) {
      return c.json(
        { error: 'invalid part: use lowercase alphanumeric, - or _ (max 32 chars)' },
        400,
      )
    }
    const machineLabel = c.req.header('X-Machine-Label') ?? c.req.query('machineLabel')

    // Validate token, membership, get-or-create connection
    let connCtx: McpConnectionContext
    try {
      connCtx = await resolveConnection(db, token, connectCode, part, machineLabel)
    }
    catch (e) {
      const err = e as { status: number; error: string }
      if (err.status === 401) {
        return c.json(
          { error: err.error },
          401,
          { 'WWW-Authenticate': wwwAuthenticateHeader(serverBase) },
        )
      }
      return c.json({ error: err.error }, err.status as 403 | 404 | 500)
    }

    // Create a new McpServer + stateless transport per request
    const mcpServer = createMcpServer(db, bus, connCtx)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    })

    await mcpServer.connect(transport)

    // handleRequest takes a web-standard Request and returns a web-standard Response
    // whose body is a STREAM the transport writes the JSON-RPC reply into. Closing
    // the server before that stream flushes truncates it (empty body → the client's
    // initialize handshake times out). So defer cleanup until the response body
    // stream finishes, instead of closing synchronously here.
    const response = await transport.handleRequest(c.req.raw)

    // Buffer the (small) JSON-RPC reply, normalize tool schemas to the clean subset
    // every client accepts, then close the server. Buffering fully before closing
    // also avoids the truncation the streaming path warned about. Stateless mode
    // returns request/response bodies (no long-lived push stream), so this is safe.
    if (response.body) {
      const raw = await new Response(response.body).text()
      await mcpServer.close().catch(() => {})
      const body = normalizeToolSchemas(raw)
      const headers = new Headers(response.headers)
      headers.delete('content-length') // body length may have changed
      return new Response(body, { status: response.status, statusText: response.statusText, headers })
    }

    await mcpServer.close().catch(() => {})
    return response
  })

  return route
}
