/**
 * Agent-token context helpers.
 *
 * Reads a Bearer token from the Authorization header, looks it up in the
 * `better_auth_oauth_access_token` table (added by the oidcProvider plugin),
 * verifies it has not expired or been revoked (deleted), and resolves the full
 * scope chain: token -> agent_connection -> agent -> project -> org.
 *
 * Used by routes/sse.ts to attach scope to the SSE context when a valid token
 * is present. Auth enforcement on /mcp is handled directly in routes/mcp.ts
 * (unconditional, independent of any env flag).
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { agentConnections, agents, projects } from '@relayroom/db'
import type { Context } from 'hono'
import { tokenScopeAllowsProject } from './lib/token-scope'

// We query auth schema tables directly; import them from @relayroom/db/auth-schema
// but because the server's createDb() uses drizzle(client, { schema }) with only
// the main schema, we use raw SQL for the oauth_access_token lookup rather than
// the ORM schema. This avoids adding auth-schema to the server's schema object
// (which would require changing createDb exports).
//
// The query is simple: SELECT id, access_token_expires_at, scopes FROM
// better_auth_oauth_access_token WHERE access_token = $1 AND
// access_token_expires_at > now(). A deleted row means revoked.

export interface AgentTokenContext {
  /** The raw bearer token from the Authorization header. */
  token: string
  /** Resolved agent part slug. */
  agentPart: string
  /** Resolved project id (UUID). */
  projectId: string
  /** Resolved project slug. */
  projectSlug: string
  /** Resolved org id. */
  orgId: string
  /** Resolved agent_connection id. */
  connectionId: string
  /** Resolved agent id. */
  agentId: string
}

/**
 * Extracts the Bearer token from the Authorization header, or returns null.
 */
function extractBearer(c: Context): string | null {
  const auth = c.req.header('Authorization') ?? ''
  const match = /^Bearer (.+)$/i.exec(auth)
  return match ? (match[1] ?? null) : null
}

interface TokenRow {
  id: string
  accessTokenExpiresAt: Date | null
  scopes: string | null
  /** Which issuer minted this token - see lib/token-scope.ts. */
  clientId: string | null
}

/**
 * Look up an access token in better_auth_oauth_access_token via Drizzle's
 * raw sql() helper (the server's Drizzle instance doesn't include auth schema).
 */
/**
 * Token lookup via postgres.js $client (tagged template).
 * db.$client is the postgres.js Sql instance from createDb().
 *
 * Returns null if token not found OR already expired (checked in SQL with NOW()).
 */
async function lookupToken(db: Db, token: string): Promise<TokenRow | null> {
  try {
    // postgres.js sql tagged template: sql`...${val}...` returns a RowList (array).
    // Expiry is enforced in SQL (access_token_expires_at IS NULL OR > NOW()).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pgClient = (db as any).$client
    const rows: Array<{
      id: string
      access_token_expires_at: Date | null
      scopes: string | null
      client_id: string | null
    }> = await pgClient`
      SELECT id, access_token_expires_at, scopes, client_id
      FROM better_auth_oauth_access_token
      WHERE access_token = ${token}
        AND (access_token_expires_at IS NULL OR access_token_expires_at > NOW())
      LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      accessTokenExpiresAt: row.access_token_expires_at,
      scopes: row.scopes,
      clientId: row.client_id,
    }
  }
  catch {
    return null
  }
}

/**
 * Validate a bearer token and resolve scope chain.
 *
 * Returns null if:
 *   - Token not found (deleted = revoked)
 *   - Token expired (access_token_expires_at < now())
 *   - No active agent_connection references this token
 */
async function validateToken(
  db: Db,
  token: string,
): Promise<AgentTokenContext | null> {
  try {
    // Step 1: Look up token in oauth table via raw SQL
    const tokenRow = await lookupToken(db, token)
    if (!tokenRow) return null

    // Step 2: Check expiry
    if (tokenRow.accessTokenExpiresAt && tokenRow.accessTokenExpiresAt < new Date()) {
      return null
    }

    // Step 3: Resolve agent_connection -> agent -> project scope
    // agentConnections.accessTokenId stores the token's 'id' (not the raw token).
    const [row] = await db
      .select({
        connectionId: agentConnections.id,
        agentId: agents.id,
        agentPart: agents.part,
        projectId: projects.id,
        projectSlug: projects.slug,
        orgId: projects.organizationId,
      })
      .from(agentConnections)
      .innerJoin(agents, eq(agentConnections.agentId, agents.id))
      .innerJoin(projects, eq(agents.projectId, projects.id))
      .where(
        and(
          eq(agentConnections.accessTokenId, tokenRow.id),
          eq(agentConnections.status, 'connected'),
        ),
      )
      .limit(1)

    if (!row) return null

    // Token project scope (BUG-0007). `scopes` was already selected here and still
    // never consulted; the project came from whichever agent_connection the token
    // happened to have. Checked AFTER the join, because that join is what resolves
    // which project this stream would be scoped to. A mismatch returns no context,
    // so the SSE route refuses rather than subscribing to another project's events.
    if (!tokenScopeAllowsProject(tokenRow.clientId, tokenRow.scopes, row.projectId)) {
      return null
    }

    return {
      token,
      agentPart: row.agentPart,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      orgId: row.orgId,
      connectionId: row.connectionId,
      agentId: row.agentId,
    }
  }
  catch {
    return null
  }
}

/**
 * Touch last_seen_at on the agent_connection (fire-and-forget; don't fail on error).
 */
async function touchConnection(db: Db, connectionId: string): Promise<void> {
  await db
    .update(agentConnections)
    .set({ lastSeenAt: new Date() })
    .where(eq(agentConnections.id, connectionId))
    .catch(() => undefined)
}

/**
 * Read the resolved agent token context attached by the SSE route, if any.
 *
 * Returns undefined when no valid token was presented. Routes use this to
 * decide whether to derive scope authoritatively from the token.
 */
export function getAgentTokenContext(c: Context): AgentTokenContext | undefined {
  return c.get('agentTokenCtx') as AgentTokenContext | undefined
}

/**
 * Attempt to validate and attach a bearer token context to the Hono context.
 *
 * Called by routes that optionally accept a token (e.g. routes/sse.ts).
 * If a token is present and valid, attaches `agentTokenCtx` and touches
 * last_seen_at. If absent or invalid, does nothing (no error).
 */
export async function tryAttachTokenContext(db: Db, c: Context): Promise<void> {
  const token = extractBearer(c)
  if (!token) return
  const ctx = await validateToken(db, token)
  if (!ctx) return
  c.set('agentTokenCtx', ctx)
  void touchConnection(db, ctx.connectionId)
}
