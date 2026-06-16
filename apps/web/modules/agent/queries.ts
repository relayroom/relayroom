import { and, count, desc, eq, isNull, sql } from "drizzle-orm"
import type { ApiResultWithItem, ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { agents, agentConnections, agentSnapshots, events, messages, threads, projects } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"
import type { AgentStatus } from "@/components/agent/agent-status-badge"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentRow {
  id: string
  projectId: string
  part: string
  role: string
  nickname: string | null
  badge: string | null
  color: string | null
  icon: string | null
  ownerUserId: string | null
  /** Owner display name (nickname or name), for multi-user projects. */
  ownerName: string | null
  lastSeenAt: Date | null
  /** Last pager heartbeat (pager liveness, independent of agent activity). */
  pagerLastSeenAt: Date | null
  /** Whether the pager has beaten recently (process is alive). */
  pagerOnline: boolean
  createdAt: Date
  // From latest connection
  model: string | null
  status: string | null
  /** Latest connection id (for disconnect/revoke). Null if no connection exists. */
  connectionId: string | null
  /** Latest connection last_seen_at (from agent_connection, more precise than agent.lastSeenAt). */
  connectionLastSeenAt: Date | null
  /** Derived live activity status (connection + latest event). */
  activity: AgentStatus
  /** Token usage totals across all events. */
  usageInput: number
  usageOutput: number
  usageCache: number
}

/** Derive a coarse live status from connection state + the latest event. */
export function deriveAgentStatus(args: {
  connStatus: string | null
  lastSeenAt: Date | null
  latestEventType: string | null
  latestEventAt: Date | null
}): AgentStatus {
  const now = Date.now()
  const seenSecs = args.lastSeenAt ? (now - args.lastSeenAt.getTime()) / 1000 : Infinity
  const evtSecs = args.latestEventAt ? (now - args.latestEventAt.getTime()) / 1000 : Infinity
  if (args.connStatus === "revoked" || args.connStatus === "expired") return "offline"
  if (args.latestEventType === "error" && evtSecs < 300) return "error"
  if (args.connStatus === "connected") {
    if (["progress", "spawn"].includes(args.latestEventType ?? "") && evtSecs < 120) return "working"
    if (seenSecs < 300) return "idle"
  }
  return "offline"
}

// The pager beats every ~30s; treat it as online within 3 missed beats.
export const PAGER_ONLINE_WINDOW_MS = 90_000

/** Whether the pager process is alive (heartbeat within the online window). */
export function isPagerOnline(pagerLastSeenAt: Date | null | undefined): boolean {
  if (!pagerLastSeenAt) return false
  return Date.now() - pagerLastSeenAt.getTime() < PAGER_ONLINE_WINDOW_MS
}

export interface AgentConnectionDetail {
  id: string
  machineLabel: string | null
  model: string | null
  repo: string | null
  branch: string | null
  status: string
  connectedAt: Date
  lastSeenAt: Date | null
}

export interface AgentUsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheTokens: number
  totalCostUsd: number
  eventCount: number
}

export interface AgentDetail {
  id: string
  projectId: string
  part: string
  role: string
  nickname: string | null
  badge: string | null
  color: string | null
  icon: string | null
  ownerUserId: string | null
  lastSeenAt: Date | null
  /** Last pager heartbeat + derived liveness (pager process alive). */
  pagerLastSeenAt: Date | null
  pagerOnline: boolean
  createdAt: Date
  updatedAt: Date
  connections: AgentConnectionDetail[]
  usageSummary: AgentUsageSummary
  spawnedSubAgentCount: number
  recentThreadIds: string[]
  recentEventIds: string[]
  /** Distinct models this agent has used, most-recent first. */
  models: string[]
  /** When the pager last reported RELAYROOM.md present in the worktree (null = not synced). */
  relayroomMdSyncedAt: Date | null
}

// ── listAgents ────────────────────────────────────────────────────────────────

export async function listAgents(
  projectId: string,
): Promise<ApiResultWithItems<AgentRow>> {
  try {
    // Agents + owner display name.
    const rows = await db
      .select({
        id: agents.id,
        projectId: agents.projectId,
        part: agents.part,
        role: agents.role,
        nickname: agents.nickname,
        badge: agents.badge,
        color: agents.color,
        icon: agents.icon,
        ownerUserId: agents.ownerUserId,
        ownerName: sql<string | null>`coalesce(nullif(${better_auth_user.nickname}, ''), ${better_auth_user.name})`,
        lastSeenAt: agents.lastSeenAt,
        pagerLastSeenAt: agents.pagerLastSeenAt,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .leftJoin(better_auth_user, eq(agents.ownerUserId, better_auth_user.id))
      .where(and(eq(agents.projectId, projectId), isNull(agents.deletedAt)))
      .orderBy(desc(agents.createdAt))

    const agentIds = rows.map((r) => r.id)
    const connectionMap = new Map<string, { id: string; model: string | null; status: string | null; lastSeenAt: Date | null }>()
    const usageMap = new Map<string, { input: number; output: number; cache: number; model: string | null }>()
    const eventMap = new Map<string, { type: string; createdAt: Date }>()

    if (agentIds.length > 0) {
      // Latest connection per agent.
      for (const agentId of agentIds) {
        const [conn] = await db
          .select({ id: agentConnections.id, model: agentConnections.model, status: agentConnections.status, lastSeenAt: agentConnections.lastSeenAt })
          .from(agentConnections)
          .where(eq(agentConnections.agentId, agentId))
          .orderBy(desc(agentConnections.connectedAt))
          .limit(1)
        if (conn) connectionMap.set(agentId, conn)
      }

      const idList = sql.join(agentIds.map((id) => sql`${id}`), sql`, `)

      // Usage totals per agent (one query).
      const usageRows = await db.execute(sql`
        SELECT agent_id,
          COALESCE(SUM((usage->>'input_tokens')::numeric), 0) AS input,
          COALESCE(SUM((usage->>'output_tokens')::numeric), 0) AS output,
          COALESCE(SUM((usage->>'cache_tokens')::numeric), 0) AS cache,
          (ARRAY_AGG(usage->>'model' ORDER BY created_at DESC) FILTER (WHERE usage->>'model' IS NOT NULL))[1] AS model
        FROM event
        WHERE project_id = ${projectId} AND agent_id IN (${idList}) AND usage IS NOT NULL
        GROUP BY agent_id
      `)
      for (const r of (usageRows.rows ?? []) as Array<{ agent_id: string; input: string | number; output: string | number; cache: string | number; model: string | null }>) {
        usageMap.set(r.agent_id, { input: Number(r.input), output: Number(r.output), cache: Number(r.cache), model: r.model })
      }

      // Latest event type/time per agent (one query).
      const evRows = await db.execute(sql`
        SELECT DISTINCT ON (agent_id) agent_id, type, created_at
        FROM event
        WHERE project_id = ${projectId} AND agent_id IN (${idList})
        ORDER BY agent_id, created_at DESC
      `)
      for (const r of (evRows.rows ?? []) as Array<{ agent_id: string; type: string; created_at: string }>) {
        eventMap.set(r.agent_id, { type: r.type, createdAt: new Date(r.created_at) })
      }
    }

    const items: AgentRow[] = rows.map((r) => {
      const conn = connectionMap.get(r.id)
      const usage = usageMap.get(r.id)
      const ev = eventMap.get(r.id)
      const connLastSeen = conn?.lastSeenAt ?? null
      return {
        ...r,
        model: conn?.model ?? usage?.model ?? null,
        status: conn?.status ?? null,
        connectionId: conn?.id ?? null,
        connectionLastSeenAt: connLastSeen,
        usageInput: usage?.input ?? 0,
        usageOutput: usage?.output ?? 0,
        usageCache: usage?.cache ?? 0,
        pagerOnline: isPagerOnline(r.pagerLastSeenAt),
        activity: deriveAgentStatus({
          connStatus: conn?.status ?? null,
          lastSeenAt: connLastSeen ?? r.lastSeenAt,
          latestEventType: ev?.type ?? null,
          latestEventAt: ev?.createdAt ?? null,
        }),
      }
    })

    return { result: true, totalCount: items.length, items }
  } catch (err) {
    console.error("[listAgents]", err)
    return { result: false, message: "에이전트 목록을 불러오는 데 실패했습니다." }
  }
}

// ── listMyAgents (global agents page) ────────────────────────────────────────

export interface MyAgentRow {
  id: string
  part: string
  role: string
  nickname: string | null
  color: string | null
  icon: string | null
  projectSlug: string
  projectName: string
  model: string | null
  status: string | null
  activity: AgentStatus
  usageInput: number
  usageOutput: number
  usageCache: number
  lastSeenAt: Date | null
}

/**
 * Every agent the user owns, across all their projects - backs the global
 * Agents page so they do not have to dig into each project. Enriched with model,
 * derived status, and usage like the per-project list.
 */
export async function listMyAgents(userId: string): Promise<ApiResultWithItems<MyAgentRow>> {
  try {
    const rows = await db
      .select({
        id: agents.id,
        part: agents.part,
        role: agents.role,
        nickname: agents.nickname,
        color: agents.color,
        icon: agents.icon,
        lastSeenAt: agents.lastSeenAt,
        createdAt: agents.createdAt,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(agents)
      .innerJoin(projects, eq(agents.projectId, projects.id))
      .where(and(eq(agents.ownerUserId, userId), isNull(projects.archivedAt), isNull(agents.deletedAt)))
      .orderBy(desc(agents.createdAt))

    const agentIds = rows.map((r) => r.id)
    const connectionMap = new Map<string, { status: string | null; model: string | null; lastSeenAt: Date | null }>()
    const usageMap = new Map<string, { input: number; output: number; cache: number; model: string | null }>()
    const eventMap = new Map<string, { type: string; createdAt: Date }>()

    if (agentIds.length > 0) {
      for (const aid of agentIds) {
        const [conn] = await db
          .select({ status: agentConnections.status, model: agentConnections.model, lastSeenAt: agentConnections.lastSeenAt })
          .from(agentConnections)
          .where(eq(agentConnections.agentId, aid))
          .orderBy(desc(agentConnections.connectedAt))
          .limit(1)
        if (conn) connectionMap.set(aid, conn)
      }
      const idList = sql.join(agentIds.map((id) => sql`${id}`), sql`, `)
      const usageRows = await db.execute(sql`
        SELECT agent_id,
          COALESCE(SUM((usage->>'input_tokens')::numeric), 0) AS input,
          COALESCE(SUM((usage->>'output_tokens')::numeric), 0) AS output,
          COALESCE(SUM((usage->>'cache_tokens')::numeric), 0) AS cache,
          (ARRAY_AGG(usage->>'model' ORDER BY created_at DESC) FILTER (WHERE usage->>'model' IS NOT NULL))[1] AS model
        FROM event WHERE agent_id IN (${idList}) AND usage IS NOT NULL GROUP BY agent_id
      `)
      for (const r of (usageRows.rows ?? []) as Array<{ agent_id: string; input: string | number; output: string | number; cache: string | number; model: string | null }>) {
        usageMap.set(r.agent_id, { input: Number(r.input), output: Number(r.output), cache: Number(r.cache), model: r.model })
      }
      const evRows = await db.execute(sql`
        SELECT DISTINCT ON (agent_id) agent_id, type, created_at
        FROM event WHERE agent_id IN (${idList}) ORDER BY agent_id, created_at DESC
      `)
      for (const r of (evRows.rows ?? []) as Array<{ agent_id: string; type: string; created_at: string }>) {
        eventMap.set(r.agent_id, { type: r.type, createdAt: new Date(r.created_at) })
      }
    }

    const items: MyAgentRow[] = rows.map((r) => {
      const conn = connectionMap.get(r.id)
      const usage = usageMap.get(r.id)
      const ev = eventMap.get(r.id)
      return {
        id: r.id,
        part: r.part,
        role: r.role,
        nickname: r.nickname,
        color: r.color,
        icon: r.icon,
        projectSlug: r.projectSlug,
        projectName: r.projectName,
        lastSeenAt: conn?.lastSeenAt ?? r.lastSeenAt,
        model: conn?.model ?? usage?.model ?? null,
        status: conn?.status ?? null,
        usageInput: usage?.input ?? 0,
        usageOutput: usage?.output ?? 0,
        usageCache: usage?.cache ?? 0,
        activity: deriveAgentStatus({
          connStatus: conn?.status ?? null,
          lastSeenAt: conn?.lastSeenAt ?? r.lastSeenAt,
          latestEventType: ev?.type ?? null,
          latestEventAt: ev?.createdAt ?? null,
        }),
      }
    })

    return { result: true, totalCount: items.length, items }
  } catch (err) {
    console.error("[listMyAgents]", err)
    return { result: false, message: "에이전트 목록을 불러오는 데 실패했습니다." }
  }
}

// ── Per-model usage (agent detail chart) ─────────────────────────────────────

export interface AgentModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
  costUsd: number
}
export interface AgentUsageByModel {
  models: AgentModelUsage[]
  /** Per-day total tokens broken out by model (newest day last). */
  days: { day: string; perModel: Record<string, number> }[]
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Token usage for one agent split by model: per-model totals plus a per-day
 * per-model matrix over the last `windowDays` days, for the agent detail chart.
 * A single agent may switch models, so this breaks usage out by model name.
 */
export async function getAgentUsageByModel(
  agentId: string,
  windowDays = 30,
): Promise<AgentUsageByModel> {
  try {
    const [totalRes, dailyRes] = await Promise.all([
      db.execute(sql`
        SELECT COALESCE(NULLIF(usage->>'model', ''), 'unknown') AS model,
          COALESCE(SUM((usage->>'input_tokens')::numeric), 0) AS input,
          COALESCE(SUM((usage->>'output_tokens')::numeric), 0) AS output,
          COALESCE(SUM((usage->>'cache_tokens')::numeric), 0) AS cache,
          COALESCE(SUM((usage->>'cost_usd')::numeric), 0) AS cost
        FROM event
        WHERE agent_id = ${agentId} AND usage IS NOT NULL
        GROUP BY 1
        ORDER BY (SUM((usage->>'input_tokens')::numeric) + SUM((usage->>'output_tokens')::numeric) + SUM((usage->>'cache_tokens')::numeric)) DESC
      `),
      db.execute(sql`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          COALESCE(NULLIF(usage->>'model', ''), 'unknown') AS model,
          COALESCE(SUM(
            (usage->>'input_tokens')::numeric + (usage->>'output_tokens')::numeric + (usage->>'cache_tokens')::numeric
          ), 0) AS total
        FROM event
        WHERE agent_id = ${agentId} AND usage IS NOT NULL
          AND created_at >= now() - make_interval(days => ${windowDays})
        GROUP BY 1, 2
      `),
    ])

    const models: AgentModelUsage[] = ((totalRes.rows ?? []) as Array<{ model: string; input: string | number; output: string | number; cache: string | number; cost: string | number }>).map((r) => {
      const inputTokens = Number(r.input)
      const outputTokens = Number(r.output)
      const cacheTokens = Number(r.cache)
      return { model: r.model, inputTokens, outputTokens, cacheTokens, totalTokens: inputTokens + outputTokens + cacheTokens, costUsd: Number(r.cost) }
    })

    const byDay = new Map<string, Record<string, number>>()
    for (const r of (dailyRes.rows ?? []) as Array<{ day: string; model: string; total: string | number }>) {
      const m = byDay.get(r.day) ?? {}
      m[r.model] = (m[r.model] ?? 0) + Number(r.total)
      byDay.set(r.day, m)
    }
    // Zero-filled day spine (oldest first).
    const days: { day: string; perModel: Record<string, number> }[] = []
    for (let i = windowDays - 1; i >= 0; i--) {
      const d = isoDay(new Date(Date.now() - i * 86_400_000))
      days.push({ day: d, perModel: byDay.get(d) ?? {} })
    }

    return { models, days }
  } catch (err) {
    console.error("[getAgentUsageByModel]", err)
    return { models: [], days: [] }
  }
}

/** Agent worktree snapshot (memory / repo / branch / files) for the inspect view. */
export interface AgentSnapshot {
  repo: string | null
  branch: string | null
  memory: string | null
  files: Record<string, string>
  syncedAt: Date | null
}

export async function getAgentSnapshot(agentId: string): Promise<AgentSnapshot | null> {
  try {
    const [row] = await db
      .select({
        repo: agentSnapshots.repo,
        branch: agentSnapshots.branch,
        memory: agentSnapshots.memory,
        files: agentSnapshots.files,
        syncedAt: agentSnapshots.syncedAt,
      })
      .from(agentSnapshots)
      .where(eq(agentSnapshots.agentId, agentId))
      .limit(1)
    if (!row) return null
    return { ...row, files: (row.files ?? {}) as Record<string, string> }
  } catch (err) {
    console.error("[getAgentSnapshot]", err)
    return null
  }
}

// ── getMyMainAgent ────────────────────────────────────────────────────────────

/**
 * The caller's current main agent in a project, if any. Main is per-(project,
 * owner): one row at most given the `agent_project_user_main` partial unique
 * index. Used by the agent detail page to decide whether setting a new main
 * needs a "you already have a main" confirmation.
 */
export async function getMyMainAgent(
  projectId: string,
  ownerUserId: string,
): Promise<{ id: string; part: string; nickname: string | null } | null> {
  try {
    const [row] = await db
      .select({ id: agents.id, part: agents.part, nickname: agents.nickname })
      .from(agents)
      .where(
        and(
          eq(agents.projectId, projectId),
          eq(agents.ownerUserId, ownerUserId),
          eq(agents.role, "main"),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1)
    return row ?? null
  } catch (err) {
    console.error("[getMyMainAgent]", err)
    return null
  }
}

// ── getAgent ──────────────────────────────────────────────────────────────────

export async function getAgent(
  projectId: string,
  agentId: string,
): Promise<ApiResultWithItem<AgentDetail>> {
  try {
    // Fetch agent, scoped to projectId for security
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
      .limit(1)

    if (!agent || agent.projectId !== projectId) {
      return { result: false, message: "에이전트를 찾을 수 없습니다." }
    }

    // Fetch all connections
    const connections = await db
      .select({
        id: agentConnections.id,
        machineLabel: agentConnections.machineLabel,
        model: agentConnections.model,
        repo: agentConnections.repo,
        branch: agentConnections.branch,
        status: agentConnections.status,
        connectedAt: agentConnections.connectedAt,
        lastSeenAt: agentConnections.lastSeenAt,
      })
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agentId))
      .orderBy(desc(agentConnections.connectedAt))

    // Compute token usage summary from events
    const usageRows = await db
      .select({
        usage: events.usage,
      })
      .from(events)
      .where(eq(events.agentId, agentId))

    const usageSummary: AgentUsageSummary = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      totalCostUsd: 0,
      eventCount: usageRows.length,
    }
    for (const row of usageRows) {
      if (row.usage) {
        usageSummary.totalInputTokens += row.usage.input_tokens ?? 0
        usageSummary.totalOutputTokens += row.usage.output_tokens ?? 0
        usageSummary.totalCacheTokens += row.usage.cache_tokens ?? 0
        usageSummary.totalCostUsd += row.usage.cost_usd ?? 0
      }
    }

    // Count spawned sub-agents from spawn events
    const [spawnedRow] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(events)
      .where(
        sql`${events.agentId} = ${agentId} and ${events.type} = 'spawn' and ${events.spawnedAgentLabel} is not null`,
      )
    const spawnedSubAgentCount = Number(spawnedRow?.cnt ?? 0)

    // Fetch recent threads where this agent authored messages (latest 5).
    // Group by thread (one row per thread) and order by the thread's most recent
    // message. (SELECT DISTINCT + ORDER BY a non-selected column is invalid in
    // Postgres, so aggregate instead.)
    const recentThreadRows = await db
      .select({ threadId: messages.threadId })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(
        sql`${messages.fromAgentId} = ${agentId} and ${threads.projectId} = ${projectId}`,
      )
      .groupBy(messages.threadId)
      .orderBy(desc(sql`max(${messages.createdAt})`))
      .limit(5)
    const recentThreadIds = recentThreadRows.map((r) => r.threadId)

    // Fetch recent events authored by this agent (latest 10)
    const recentEventRows = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.agentId, agentId))
      .orderBy(desc(events.createdAt))
      .limit(10)
    const recentEventIds = recentEventRows.map((r) => r.id)

    // Fetch distinct models used by this agent, most-recent first
    const modelRows = await db.execute(sql`
      SELECT DISTINCT usage->>'model' AS model, MAX(created_at) AS last_used
      FROM event
      WHERE agent_id = ${agentId}
        AND usage->>'model' IS NOT NULL
        AND usage->>'model' != ''
      GROUP BY usage->>'model'
      ORDER BY MAX(created_at) DESC
    `)
    const models = (modelRows.rows ?? []).map((r) => String((r as { model: string }).model))

    return {
      result: true,
      item: {
        id: agent.id,
        projectId: agent.projectId,
        part: agent.part,
        role: agent.role,
        nickname: agent.nickname,
        badge: agent.badge,
        color: agent.color,
        icon: agent.icon,
        ownerUserId: agent.ownerUserId,
        lastSeenAt: agent.lastSeenAt,
        pagerLastSeenAt: agent.pagerLastSeenAt,
        pagerOnline: isPagerOnline(agent.pagerLastSeenAt),
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        connections,
        usageSummary,
        spawnedSubAgentCount,
        recentThreadIds,
        recentEventIds,
        models,
        relayroomMdSyncedAt: agent.relayroomMdSyncedAt,
      },
    }
  } catch (err) {
    console.error("[getAgent]", err)
    return { result: false, message: "에이전트 정보를 불러오는 데 실패했습니다." }
  }
}
