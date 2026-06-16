/**
 * Reversible governance ban / unban core (phase 09, spec §10.3-4, §10.6).
 *
 * Lives in @relayroom/db (not apps/server) because both the Hono server and the
 * Next.js web Server Action need it, and each app uses a different drizzle driver
 * (postgres-js vs node-postgres). Keeping it here, on the shared query builder,
 * means one implementation with no web->server dependency. apps/server re-exports
 * it from src/governance/ban.ts for locality.
 *
 * A ban is NOT a hard delete. It toggles project_access.bannedAt and, as a side
 * effect, severs the member's live access: revoke their agent connections,
 * invalidate their MCP tokens, and cancel+refund their parts' pending wakes.
 * Sent messages are preserved (in-flight is not erased - control side only).
 *
 * Budget refund model (03): a reservation lives in the rolling window only while
 * the wake_intent is in a non-terminal state (pending|delivered|activated).
 * Transitioning the intent to the terminal 'canceled' state IS the refund - it
 * drops out of countWindow with no compensating event row written. We never touch
 * the rolling-window counters directly (control/ledger separation, 05 invariant).
 *
 * Enforcement boundary: even when project-scoped token invalidation cannot reach a
 * user-scoped token, the bannedAt gate in mcp.ts resolveConnection rejects the
 * banned user's connect/send. This module makes the ban immediate; that gate makes
 * it authoritative.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { agentConnections, agents, projectAccess, projects, wakeIntents } from './schema'
import { better_auth_oauth_access_token } from './auth-schema'

/**
 * Driver-agnostic db handle. The Hono server uses postgres-js drizzle and the
 * Next.js web app uses node-postgres drizzle; both extend PgDatabase, and these
 * functions only touch the shared query-builder + transaction surface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GovDb = PgDatabase<any, any, any>

/** project = this project only; org = every project in the org (spec §10.3). */
export interface BanScope { kind: 'project' | 'org' }

export interface ApplyBanOpts {
  projectId: string
  userId: string
  scope: BanScope
  bannedByUserId: string
  orgId: string
}

export interface ApplyBanResult {
  revokedConnections: number
  canceledWakes: number
  refundedWakes: number
}

/** Non-terminal wake states whose reservation still occupies the budget window. */
const ACTIVE_WAKE_STATES = ['pending', 'delivered', 'activated'] as const

/**
 * drizzle inArray over uuids can emit `= ANY` which breaks on this stack; build an
 * explicit `IN (...)` list. (00 convention.) Caller guards against an empty list.
 */
function sqlIn(column: ReturnType<typeof sql>, ids: string[]) {
  return sql`${column} in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`
}

/** The set of project ids a ban applies to for the given scope. */
async function resolveTargetProjects(
  db: GovDb,
  scope: BanScope,
  projectId: string,
  orgId: string,
): Promise<string[]> {
  if (scope.kind === 'project') return [projectId]
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, orgId))
  return rows.map(r => r.id)
}

/**
 * Reversibly ban a member. Sets project_access.bannedAt (never deletes), revokes
 * their in-scope agent connections, invalidates their MCP tokens, and cancels +
 * refunds their parts' active wakes. Idempotent: re-banning re-revokes stragglers.
 *
 * Returns side-effect counts for the audit log / toast.
 */
export async function applyBan(db: GovDb, opts: ApplyBanOpts): Promise<ApplyBanResult> {
  const targetProjects = await resolveTargetProjects(db, opts.scope, opts.projectId, opts.orgId)
  // user-scoped tokens tied to the in-scope connections (project scope = best
  // effort). org scope expires ALL of the user's tokens regardless.
  const tokenIds = new Set<string>()
  let revokedConnections = 0
  let canceledWakes = 0
  let refundedWakes = 0

  await db.transaction(async tx => {
    for (const pid of targetProjects) {
      // (1) bannedAt toggle - reversible, NEVER a hard delete. Skips members with
      // no project_access row (org member who never joined this project).
      await tx
        .update(projectAccess)
        .set({ bannedAt: sql`now()`, bannedByUserId: opts.bannedByUserId })
        .where(and(eq(projectAccess.projectId, pid), eq(projectAccess.userId, opts.userId)))

      // (2) find this member's agents in the project.
      const memberAgents = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.projectId, pid), eq(agents.ownerUserId, opts.userId)))
      const agentIds = memberAgents.map(a => a.id)
      if (agentIds.length === 0) continue

      // (3) collect token ids tied to these connections, then revoke the live ones.
      const conns = await tx
        .select({ accessTokenId: agentConnections.accessTokenId })
        .from(agentConnections)
        .where(
          and(
            sqlIn(sql`${agentConnections.agentId}`, agentIds),
            isNotNull(agentConnections.accessTokenId),
          ),
        )
      for (const c of conns) {
        if (c.accessTokenId) tokenIds.add(c.accessTokenId)
      }

      const revoked = await tx
        .update(agentConnections)
        .set({ status: 'revoked' })
        .where(
          and(
            sqlIn(sql`${agentConnections.agentId}`, agentIds),
            eq(agentConnections.status, 'connected'),
          ),
        )
        .returning({ id: agentConnections.id })
      revokedConnections += revoked.length

      // (4) cancel + refund the member's active wakes. Transition to terminal
      // 'canceled' = the refund (03 model: drops out of the window, no event row).
      const active = await tx
        .select({ id: wakeIntents.id })
        .from(wakeIntents)
        .where(
          and(
            sqlIn(sql`${wakeIntents.agentId}`, agentIds),
            inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[]),
          ),
        )
      if (active.length > 0) {
        const ids = active.map(w => w.id)
        await tx
          .update(wakeIntents)
          .set({ state: 'canceled' })
          .where(sqlIn(sql`${wakeIntents.id}`, ids))
        canceledWakes += active.length
        refundedWakes += active.length
      }
    }

    // (4b) invalidate MCP tokens by expiring them. lookupOauthToken (mcp.ts) filters
    // access_token_expires_at > NOW(), so the next MCP request 401s. Tokens are
    // user-scoped: org-scope ban legitimately kills them all; project-scope only
    // expires the tokens tied to in-scope connections (best-effort) - the
    // authoritative project boundary is the bannedAt gate in resolveConnection.
    if (opts.scope.kind === 'org') {
      await tx
        .update(better_auth_oauth_access_token)
        .set({ accessTokenExpiresAt: new Date() })
        .where(eq(better_auth_oauth_access_token.userId, opts.userId))
    }
    else if (tokenIds.size > 0) {
      await tx
        .update(better_auth_oauth_access_token)
        .set({ accessTokenExpiresAt: new Date() })
        .where(sqlIn(sql`${better_auth_oauth_access_token.id}`, [...tokenIds]))
    }
  })

  return { revokedConnections, canceledWakes, refundedWakes }
}

export interface ApplyUnbanOpts {
  projectId: string
  userId: string
  scope: BanScope
  orgId: string
}

/**
 * Reverse a ban: clear project_access.bannedAt / bannedByUserId on the in-scope
 * projects. Does NOT auto-reconnect agents or re-issue tokens - the user must run
 * `relayroom connect` again to mint fresh tokens + connections (spec §10.4).
 * Does not create wakes; suppressed wakes are reclaimed by the 03 sweep or the
 * next message naturally.
 */
export async function applyUnban(db: GovDb, opts: ApplyUnbanOpts): Promise<void> {
  const targetProjects = await resolveTargetProjects(db, opts.scope, opts.projectId, opts.orgId)
  await db.transaction(async tx => {
    for (const pid of targetProjects) {
      await tx
        .update(projectAccess)
        .set({ bannedAt: null, bannedByUserId: null })
        .where(and(eq(projectAccess.projectId, pid), eq(projectAccess.userId, opts.userId)))
    }
  })
}
