"use server"

import { and, eq, inArray, isNull, or } from "drizzle-orm"
import { randomBytes } from "node:crypto"
import type { ApiResult, ApiResultWithItem } from "@relayroom/shared"
import {
  updateAgentSchema,
  type UpdateAgentInput,
  connectAgentSchema,
  type ConnectAgentInput,
} from "./schema"
import { db } from "@/modules/drizzle/db"
import {
  agents,
  agentConnections,
  projects,
  events,
  threads,
  messages,
  messageRecipients,
} from "@relayroom/db/schema"
import {
  better_auth_member,
  better_auth_oauth_application,
  better_auth_oauth_access_token,
  better_auth_user,
} from "@relayroom/db/auth-schema"
import { getServerSession, requireProjectAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getErrorTranslations } from "@/lib/action-i18n"
import { isUuid } from "@/lib/uuid"
import { requireProjectManage } from "@/modules/project/member-actions"

// ── Helpers ───────────────────────────────────────────────────────────────────

type Session = NonNullable<Awaited<ReturnType<typeof getServerSession>>>

async function requireOrgAccess(): Promise<
  | { ok: true; session: Session; orgId: string }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()
  const session = await getServerSession()
  if (!session) return { ok: false, message: t("auth.loginRequired") }

  const orgId = await resolveActiveOrgId()
  if (!orgId) return { ok: false, message: t("auth.orgRequired") }

  const [member] = await db
    .select({ id: better_auth_member.id })
    .from(better_auth_member)
    .where(
      and(
        eq(better_auth_member.organizationId, orgId),
        eq(better_auth_member.userId, session.user.id),
      ),
    )
    .limit(1)

  if (!member) return { ok: false, message: t("auth.noOrgAccess") }

  return { ok: true, session, orgId }
}

/**
 * Resolve the agent and verify it belongs to a project in the caller's org.
 * Returns the agent row on success.
 *
 * SECURITY: joins agents -> projects -> org check. An agentId from another org
 * will not match, preventing IDOR.
 */
async function requireAgentInOrg(
  agentId: string,
  orgId: string,
): Promise<
  | { ok: true; agent: { id: string; projectId: string; part: string; role: string; ownerUserId: string | null } }
  | { ok: false; message: string }
> {
  // A malformed id never matches a uuid column (and would raise a Postgres syntax
  // error); treat it as not-found before it reaches the query.
  if (!isUuid(agentId)) {
    const t = await getErrorTranslations()
    return { ok: false, message: t("agent.notFound") }
  }
  const [row] = await db
    .select({
      id: agents.id,
      projectId: agents.projectId,
      part: agents.part,
      role: agents.role,
      ownerUserId: agents.ownerUserId,
    })
    .from(agents)
    .innerJoin(projects, eq(agents.projectId, projects.id))
    .where(
      and(
        eq(agents.id, agentId),
        eq(projects.organizationId, orgId),
      ),
    )
    .limit(1)

  if (!row) {
    const t = await getErrorTranslations()
    return { ok: false, message: t("agent.notFound") }
  }
  return { ok: true, agent: row }
}

/**
 * Resolve + authorize an agent-management action (AC-3): edit / set-main /
 * disconnect / delete. Beyond org membership (IDOR guard), the caller must be
 * either the agent's own owner (ownerUserId) OR a project manager (project
 * owner / org owner-admin, via `requireProjectManage`). This stops any org
 * member from renaming, disconnecting, or deleting a part they neither own nor
 * administer.
 */
async function requireAgentManage(
  agentId: string,
  orgId: string,
): Promise<
  | { ok: true; agent: { id: string; projectId: string; part: string; role: string; ownerUserId: string | null } }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()
  const agentCheck = await requireAgentInOrg(agentId, orgId)
  if (!agentCheck.ok) return agentCheck
  const { agent } = agentCheck

  const session = await getServerSession()
  if (!session) return { ok: false, message: t("auth.loginRequired") }

  if (agent.ownerUserId === session.user.id) {
    return { ok: true, agent }
  }

  const manage = await requireProjectManage(agent.projectId)
  if (!manage.ok) return { ok: false, message: t("agent.manageDenied") }

  return { ok: true, agent }
}

// ── updateAgent ───────────────────────────────────────────────────────────────

export async function updateAgent(input: UpdateAgentInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    const parsed = updateAgentSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const { agentId, nickname, badge } = parsed.data

    // AC-3: IDOR guard + agent owner / project manager gate.
    const agentCheck = await requireAgentManage(agentId, orgId)
    if (!agentCheck.ok) return { result: false, message: agentCheck.message }

    const updateFields: Partial<{ nickname: string | null; badge: string | null; updatedAt: Date }> = {
      updatedAt: new Date(),
    }
    if (nickname !== undefined) updateFields.nickname = nickname || null
    if (badge !== undefined) updateFields.badge = badge || null

    await db
      .update(agents)
      .set(updateFields)
      .where(eq(agents.id, agentId))

    return { result: true }
  } catch (err) {
    console.error("[updateAgent]", err)
    return { result: false, message: t("agent.updateFailed") }
  }
}

// ── setMainAgent ────────────────────────────────────────────────────────────

/**
 * Set an agent as the main for its (project, ownerUserId) pair.
 *
 * The partial unique index `agent_project_user_main` enforces that only one
 * agent per (project, owner) can have role='main'. We handle the conflict
 * gracefully by first clearing any existing main for that combo, then setting
 * the new one.
 */
export async function setMainAgent(agentId: string): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { session, orgId } = access

    // AC-3: IDOR guard + agent owner / project manager gate.
    const agentCheck = await requireAgentManage(agentId, orgId)
    if (!agentCheck.ok) return { result: false, message: agentCheck.message }

    const { agent } = agentCheck

    // Capture the part of the main being replaced (for the event + broadcast),
    // before we clear it. Scoped to the same (project, owner) pair as the swap.
    const fromMainWhere = agent.ownerUserId
      ? and(
          eq(agents.projectId, agent.projectId),
          eq(agents.ownerUserId, agent.ownerUserId),
          eq(agents.role, "main"),
        )
      : and(eq(agents.projectId, agent.projectId), eq(agents.role, "main"))

    const [prevMain] = await db
      .select({ id: agents.id, part: agents.part })
      .from(agents)
      .where(fromMainWhere)
      .limit(1)
    const fromPart = prevMain && prevMain.id !== agentId ? prevMain.part : null

    // Clear any existing main for this (project, ownerUser) pair
    // to avoid violating the partial unique index
    await db
      .update(agents)
      .set({ role: "default", updatedAt: new Date() })
      .where(fromMainWhere)

    // Set the new main
    await db
      .update(agents)
      .set({ role: "main", updatedAt: new Date() })
      .where(eq(agents.id, agentId))

    // ── Post-swap side effects (best-effort) ──────────────────────────────────
    // All of the below is wrapped so a failure never blocks (or rolls back) the
    // swap itself, which has already committed above.
    await recordMainChange({
      projectId: agent.projectId,
      newMainId: agentId,
      newMainPart: agent.part,
      fromPart,
      byUserId: session.user.id,
    }).catch((err) => console.error("[setMainAgent] side effects", err))

    return { result: true }
  } catch (err) {
    console.error("[setMainAgent]", err)
    return { result: false, message: t("agent.setMainFailed") }
  }
}

/**
 * Best-effort durable record of a main-agent change. Runs after the swap has
 * committed; every step is guarded so it never blocks the swap.
 *
 *  1. Inserts an `events` row (type 'main_changed') for the new main.
 *  2. Broadcasts a system thread to EVERY non-deleted agent in the project
 *     (all owners, not just the caller) so each part learns of the change on its
 *     next turn-start inbox check, and it shows in the dashboard.
 *
 * CROSS-PROCESS NOTE: the live SSE/wake bus is owned by the Hono server
 * (apps/server/src/bus.ts), which fires NOTIFY only from its own MCP send/reply
 * tools. This web process has no access to that bus and there is no DB trigger
 * that emits NOTIFY on a plain message insert, so this durable broadcast is NOT
 * delivered as a live wake/nudge. Agents pick it up on their turn-start inbox
 * check and it is visible in the dashboard. A live wake on this broadcast needs
 * a server-side NOTIFY path (follow-up).
 */
async function recordMainChange(args: {
  projectId: string
  newMainId: string
  newMainPart: string
  fromPart: string | null
  byUserId: string
}): Promise<void> {
  const { projectId, newMainId, newMainPart, fromPart, byUserId } = args

  // 1. Event row for the new main.
  await db
    .insert(events)
    .values({
      projectId,
      agentId: newMainId,
      type: "main_changed",
      detail: { fromPart, toPart: newMainPart, byUserId },
    })
    .catch((err) => console.error("[recordMainChange] event", err))

  // 2. Broadcast a system thread to all non-deleted agents in the project.
  try {
    const recipients = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), isNull(agents.deletedAt)))

    if (recipients.length === 0) return

    // Caller display name (nickname falls back to name) for the message body.
    const [caller] = await db
      .select({ name: better_auth_user.name, nickname: better_auth_user.nickname })
      .from(better_auth_user)
      .where(eq(better_auth_user.id, byUserId))
      .limit(1)
    const callerName = (caller?.nickname || caller?.name) ?? "A teammate"

    const body = fromPart
      ? `${callerName}'s main agent is now '${newMainPart}' (was '${fromPart}').`
      : `${callerName}'s main agent is now '${newMainPart}'.`

    const [thread] = await db
      .insert(threads)
      .values({
        projectId,
        subject: "Main agent changed",
        createdByUserId: byUserId,
      })
      .returning({ id: threads.id })
    if (!thread) return

    const [message] = await db
      .insert(messages)
      .values({
        threadId: thread.id,
        fromUserId: byUserId,
        body,
        recipientCount: recipients.length,
      })
      .returning({ id: messages.id })
    if (!message) return

    // Insert recipients ALREADY-READ (readAt set): "Main agent changed" is an
    // informational notice, not a task. Leaving it unread would make every peer
    // agent's eligibility sweep wake it (a weak model then flails trying to "handle"
    // a notice it can't act on -> nudge loop). Recorded for history/dashboard, but
    // it never counts as unread, so it wakes no one.
    const readAt = new Date()
    await db.insert(messageRecipients).values(
      recipients.map((r) => ({ messageId: message.id, agentId: r.id, readAt })),
    )
  } catch (err) {
    console.error("[recordMainChange] broadcast", err)
  }
}

// ── connectAgent ──────────────────────────────────────────────────────────────

/**
 * MCP OAuth flow (browser consent) will replace this manual issuance.
 * For now an org member mints a token via the web using the project connect_code.
 *
 * Flow:
 *  1. Validate connect_code -> resolve project (org membership required).
 *  2. Upsert agent (project_id, part, owner_user_id=caller).
 *  3. Create agent_connection record.
 *  4. Issue an opaque bearer token stored in better_auth_oauth_access_token.
 *     The token is shown once to the user; they paste it into their agent config.
 *  5. Return ApiResultWithItem<{ token, connectionId }>.
 */
/** RelayRoom internal OAuth client ID used for programmatic token issuance. */
const INTERNAL_CLIENT_ID = "relayroom-internal-agent-client"

/** Token TTL: 1 year (agents are long-lived). MCP OAuth flow will manage rotation. */
const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000

async function ensureInternalOAuthClient() {
  // Upsert the internal OAuth application used for agent tokens.
  const now = new Date()
  const existing = await db
    .select({ clientId: better_auth_oauth_application.clientId })
    .from(better_auth_oauth_application)
    .where(eq(better_auth_oauth_application.clientId, INTERNAL_CLIENT_ID))
    .limit(1)

  if (existing.length === 0) {
    await db.insert(better_auth_oauth_application).values({
      id: `internal-client-${Date.now()}`,
      name: "RelayRoom Internal Agent Client",
      clientId: INTERNAL_CLIENT_ID,
      clientSecret: null,
      redirectUrls: "urn:ietf:wg:oauth:2.0:oob",
      type: "internal",
      disabled: false,
      userId: null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing()
  }
}

export async function connectAgent(
  input: ConnectAgentInput,
): Promise<ApiResultWithItem<{ token: string; agentId: string; projectSlug: string }>> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { session, orgId } = access

    const parsed = connectAgentSchema(t).safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { connectCode, part, nickname, color, icon } = parsed.data
    // Only set appearance/identity fields when provided, so a reconnect with blanks
    // does not wipe an existing nickname/color/icon.
    const appearance: { nickname?: string; color?: string; icon?: string } = {}
    if (nickname) appearance.nickname = nickname
    if (color) appearance.color = color
    if (icon) appearance.icon = icon

    // Resolve project from connect_code (org-scoped)
    const [project] = await db
      .select({ id: projects.id, organizationId: projects.organizationId, slug: projects.slug })
      .from(projects)
      .where(
        and(
          eq(projects.connectCode, connectCode),
          eq(projects.organizationId, orgId),
        ),
      )
      .limit(1)

    if (!project) {
      return { result: false, message: t("agent.invalidConnectCode") }
    }

    // AC-2: connecting an agent must be gated on project_access, not just org
    // membership - a `readonly` grant can view the connect_code (it's shown in
    // the project settings UI to anyone who can see the project) but must not be
    // able to mint a live agent token from it.
    const projectAccessCheck = await requireProjectAccess(session.user.id, project.id, "write")
    if (!projectAccessCheck.ok) return { result: false, message: projectAccessCheck.message }

    // Ownership gate: an existing (project, part) agent belongs to its owner. A
    // connect code is project-shared, so we must NOT let a different member seize
    // that part (and have a fresh token minted for them). Only the owner may
    // reconnect; a new or ownerless part is claimable. Transfer is a separate,
    // explicit flow. (Mirror gate in server resolveConnection.)
    const [existingAgent] = await db
      .select({ ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.projectId, project.id), eq(agents.part, part)))
      .limit(1)
    if (
      existingAgent &&
      existingAgent.ownerUserId &&
      existingAgent.ownerUserId !== session.user.id
    ) {
      return { result: false, message: t("agent.ownedByAnother") }
    }

    // Upsert agent (project_id, part) - owner_user_id = current user
    const now = new Date()
    const [agent] = await db
      .insert(agents)
      .values({
        projectId: project.id,
        part,
        role: "default",
        ownerUserId: session.user.id,
        ...appearance,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [agents.projectId, agents.part],
        // Reconnect by the same owner (gated above): refresh identity if provided.
        // deletedAt: null revives a soft-deleted part if it is added again.
        set: { ownerUserId: session.user.id, updatedAt: now, deletedAt: null, ...appearance },
        // Atomic guard against the TOCTOU between the pre-check and this upsert: only
        // update a conflicting row that is STILL ownerless or already ours. If a
        // concurrent connect grabbed it first, the update touches no row (no takeover).
        setWhere: or(isNull(agents.ownerUserId), eq(agents.ownerUserId, session.user.id)),
      })
      .returning({ id: agents.id })

    if (!agent) {
      // A fresh insert always returns a row, so an empty result means the conflict
      // row is owned by another user and setWhere blocked the update (lost the race).
      return { result: false, message: t("agent.ownedByAnother") }
    }

    // Ensure the internal OAuth application record exists
    await ensureInternalOAuthClient()

    // Issue an opaque bearer token
    const rawToken = randomBytes(32).toString("hex")
    const tokenId = `agent-token-${Date.now()}-${randomBytes(8).toString("hex")}`
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

    await db.insert(better_auth_oauth_access_token).values({
      id: tokenId,
      accessToken: rawToken,
      refreshToken: null,
      accessTokenExpiresAt: expiresAt,
      refreshTokenExpiresAt: null,
      clientId: INTERNAL_CLIENT_ID,
      userId: session.user.id,
      scopes: `project:${project.id}`,
      createdAt: now,
      updatedAt: now,
    })

    // Do NOT pre-create an agent_connection here. A connection means the agent has
    // actually connected over MCP; the server's resolveConnection creates it (with a
    // real last_seen_at) on the first authenticated call using this token. Creating
    // it now would show "connected" before the agent ever runs. The token carries the
    // (machineLabel is auto-filled later by the pager heartbeat).
    return { result: true, item: { token: rawToken, agentId: agent.id, projectSlug: project.slug } }
  } catch (err) {
    console.error("[connectAgent]", err)
    return { result: false, message: t("agent.connectFailed") }
  }
}

// ── disconnectConnection ──────────────────────────────────────────────────────

/**
 * Revoke an agent connection by connectionId.
 *
 * 1. Verifies org membership (IDOR guard via project -> org join).
 * 2. Revokes the associated OAuth access token (deletes the token row so
 *    Hono validation immediately rejects it).
 * 3. Sets agent_connection.status = 'revoked'.
 *
 * After this call, requireAgentToken middleware returns 401 for the old token.
 */
export async function disconnectConnection(connectionId: string): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(connectionId)) return { result: false, message: t("agent.connectionNotFound") }
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    // Verify connection belongs to an agent in caller's org (IDOR guard)
    const [conn] = await db
      .select({
        id: agentConnections.id,
        accessTokenId: agentConnections.accessTokenId,
        agentId: agentConnections.agentId,
      })
      .from(agentConnections)
      .innerJoin(agents, eq(agentConnections.agentId, agents.id))
      .innerJoin(projects, eq(agents.projectId, projects.id))
      .where(
        and(
          eq(agentConnections.id, connectionId),
          eq(projects.organizationId, orgId),
        ),
      )
      .limit(1)

    if (!conn) return { result: false, message: t("agent.connectionNotFound") }

    // AC-3: agent owner / project manager gate.
    const manage = await requireAgentManage(conn.agentId, orgId)
    if (!manage.ok) return { result: false, message: manage.message }

    // Revoke the OAuth access token (delete row -> Hono immediately rejects it)
    if (conn.accessTokenId) {
      await db
        .delete(better_auth_oauth_access_token)
        .where(eq(better_auth_oauth_access_token.id, conn.accessTokenId))
    }

    // Mark connection revoked
    await db
      .update(agentConnections)
      .set({ status: "revoked" })
      .where(eq(agentConnections.id, connectionId))

    return { result: true }
  } catch (err) {
    console.error("[disconnectConnection]", err)
    return { result: false, message: t("agent.disconnectFailed") }
  }
}

/**
 * Soft-delete an agent (part) - for a mistaken/abandoned agent. The row is kept
 * (deleted_at set) so threads/events still resolve this part's name in history; it
 * is hidden from active agent lists and revives if the part reconnects. Its OAuth
 * tokens are revoked and connections marked revoked so it cannot keep talking.
 */
export async function deleteAgent(agentId: string): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    // AC-3: IDOR guard + agent owner / project manager gate.
    const agentCheck = await requireAgentManage(agentId, orgId)
    if (!agentCheck.ok) return { result: false, message: agentCheck.message }

    const conns = await db
      .select({ accessTokenId: agentConnections.accessTokenId })
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agentId))
    const tokenIds = conns.map((c) => c.accessTokenId).filter((x): x is string => !!x)
    if (tokenIds.length > 0) {
      await db
        .delete(better_auth_oauth_access_token)
        .where(inArray(better_auth_oauth_access_token.id, tokenIds))
    }
    await db
      .update(agentConnections)
      .set({ status: "revoked" })
      .where(eq(agentConnections.agentId, agentId))

    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agentId))

    return { result: true }
  } catch (err) {
    console.error("[deleteAgent]", err)
    return { result: false, message: t("agent.deleteFailed") }
  }
}

/**
 * @deprecated Use disconnectConnection(connectionId) instead.
 * Kept for backward-compat while UI migrates to connection-level revoke.
 */
export async function disconnectAgent(agentId: string): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    // AC-3: IDOR guard + agent owner / project manager gate.
    const agentCheck = await requireAgentManage(agentId, orgId)
    if (!agentCheck.ok) return { result: false, message: agentCheck.message }

    // Get the latest active connection for this agent
    const [conn] = await db
      .select({
        id: agentConnections.id,
        accessTokenId: agentConnections.accessTokenId,
      })
      .from(agentConnections)
      .where(
        and(
          eq(agentConnections.agentId, agentId),
          eq(agentConnections.status, "connected"),
        ),
      )
      .orderBy(agentConnections.connectedAt)
      .limit(1)

    if (conn) {
      // Revoke OAuth token
      if (conn.accessTokenId) {
        await db
          .delete(better_auth_oauth_access_token)
          .where(eq(better_auth_oauth_access_token.id, conn.accessTokenId))
      }
      // Mark connection revoked
      await db
        .update(agentConnections)
        .set({ status: "revoked" })
        .where(eq(agentConnections.id, conn.id))
    }

    return { result: true }
  } catch (err) {
    console.error("[disconnectAgent]", err)
    return { result: false, message: t("agent.disconnectFailed") }
  }
}
