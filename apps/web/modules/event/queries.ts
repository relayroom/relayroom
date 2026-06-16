import { and, desc, eq, ilike, or, sql } from "drizzle-orm"
import type { ApiResultWithItem, ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { events, agents } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EventRow {
  id: string
  projectId: string
  agentId: string | null
  /** Emitting agent's part + owner display name + main-ness, for richer list rows. */
  agentPart: string | null
  agentRole: string | null
  ownerName: string | null
  type: string
  spawnedAgentLabel: string | null
  detail: Record<string, unknown>
  usage: {
    input_tokens?: number
    output_tokens?: number
    cache_tokens?: number
    model?: string
    cost_usd?: number
  } | null
  startedAt: Date | null
  endedAt: Date | null
  createdAt: Date
}

export interface EventFilter {
  q?: string
  /** Restrict to one agent (used by the agent detail "more events" link). */
  agentId?: string
  page?: number
  limit?: number
}

export interface EventLineageItem {
  id: string
  type: string
  spawnedAgentLabel: string | null
  agentId: string | null
  agentPart: string | null
  createdAt: Date
}

export interface EventDetail {
  id: string
  projectId: string
  agentId: string | null
  agentPart: string | null
  agentNickname: string | null
  agentRole: string | null
  agentOwnerName: string | null
  type: string
  parentEventId: string | null
  spawnedAgentLabel: string | null
  detail: Record<string, unknown>
  usage: {
    input_tokens?: number
    output_tokens?: number
    cache_tokens?: number
    model?: string
    cost_usd?: number
  } | null
  startedAt: Date | null
  endedAt: Date | null
  createdAt: Date
  /** Parent lineage chain (grandparent first, parent last) */
  lineage: EventLineageItem[]
  /** Count of direct child events spawned by this event */
  spawnedCount: number
}

// ── listEvents ────────────────────────────────────────────────────────────────

export async function listEvents(
  projectId: string,
  filter: EventFilter = {},
): Promise<ApiResultWithItems<EventRow>> {
  try {
    const page = Math.max(1, filter.page ?? 1)
    const limit = Math.max(1, Math.min(100, filter.limit ?? 50))
    const offset = (page - 1) * limit

    const conditions = [eq(events.projectId, projectId)]
    if (filter.agentId) conditions.push(eq(events.agentId, filter.agentId))

    const q = filter.q?.trim()
    if (q) {
      const like = `%${q}%`
      conditions.push(
        or(
          ilike(events.type, like),
          ilike(events.spawnedAgentLabel, like),
          ilike(agents.part, like),
          sql`${events.detail}->>'note' ILIKE ${like}`,
          sql`${events.detail}->>'title' ILIKE ${like}`,
          sql`${events.usage}->>'model' ILIKE ${like}`,
        )!,
      )
    }

    const where = and(...conditions)

    const [{ totalCount }] = await db
      .select({ totalCount: sql<number>`count(*)::int` })
      .from(events)
      .leftJoin(agents, eq(events.agentId, agents.id))
      .where(where)

    const rows = await db
      .select({
        id: events.id,
        projectId: events.projectId,
        agentId: events.agentId,
        agentPart: agents.part,
        agentRole: agents.role,
        // Prefer the configured nickname, same as listThreads, so the owner
        // label is consistent across pages.
        ownerName: sql<string | null>`coalesce(nullif(${better_auth_user.nickname}, ''), ${better_auth_user.name})`,
        type: events.type,
        spawnedAgentLabel: events.spawnedAgentLabel,
        detail: events.detail,
        usage: events.usage,
        startedAt: events.startedAt,
        endedAt: events.endedAt,
        createdAt: events.createdAt,
      })
      .from(events)
      .leftJoin(agents, eq(events.agentId, agents.id))
      .leftJoin(better_auth_user, eq(agents.ownerUserId, better_auth_user.id))
      .where(where)
      .orderBy(desc(events.createdAt))
      .limit(limit)
      .offset(offset)

    const items: EventRow[] = rows.map((r) => ({
      ...r,
      detail: (r.detail ?? {}) as Record<string, unknown>,
    }))

    return { result: true, totalCount: Number(totalCount), items }
  } catch (err) {
    console.error("[listEvents]", err)
    return { result: false, message: "이벤트 목록을 불러오는 데 실패했습니다." }
  }
}

// ── getEvent ──────────────────────────────────────────────────────────────────

export async function getEvent(
  projectId: string,
  eventId: string,
): Promise<ApiResultWithItem<EventDetail>> {
  try {
    // Fetch the event, scoped to projectId for security
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.projectId, projectId)))
      .limit(1)

    if (!event) return { result: false, message: "이벤트를 찾을 수 없습니다." }

    // Fetch emitting agent info (part, role, owner)
    let agentPart: string | null = null
    let agentNickname: string | null = null
    let agentRole: string | null = null
    let agentOwnerName: string | null = null
    if (event.agentId) {
      const [agentRow] = await db
        .select({
          part: agents.part,
          nickname: agents.nickname,
          role: agents.role,
          ownerName: sql<string | null>`coalesce(nullif(${better_auth_user.nickname}, ''), ${better_auth_user.name})`,
        })
        .from(agents)
        .leftJoin(better_auth_user, eq(agents.ownerUserId, better_auth_user.id))
        .where(eq(agents.id, event.agentId))
        .limit(1)
      agentPart = agentRow?.part ?? null
      agentNickname = agentRow?.nickname ?? null
      agentRole = agentRow?.role ?? null
      agentOwnerName = agentRow?.ownerName ?? null
    }

    // Build parent lineage chain by walking parent_event_id up to depth 10
    const lineage: EventLineageItem[] = []
    let currentParentId: string | null = event.parentEventId
    let depth = 0
    while (currentParentId && depth < 10) {
      const [parent] = await db
        .select({
          id: events.id,
          type: events.type,
          spawnedAgentLabel: events.spawnedAgentLabel,
          agentId: events.agentId,
          parentEventId: events.parentEventId,
          createdAt: events.createdAt,
        })
        .from(events)
        .where(eq(events.id, currentParentId))
        .limit(1)

      if (!parent) break

      // Fetch agent part for the parent
      let parentAgentPart: string | null = null
      if (parent.agentId) {
        const [pa] = await db
          .select({ part: agents.part })
          .from(agents)
          .where(eq(agents.id, parent.agentId))
          .limit(1)
        parentAgentPart = pa?.part ?? null
      }

      lineage.unshift({
        id: parent.id,
        type: parent.type,
        spawnedAgentLabel: parent.spawnedAgentLabel,
        agentId: parent.agentId,
        agentPart: parentAgentPart,
        createdAt: parent.createdAt,
      })

      currentParentId = parent.parentEventId
      depth++
    }

    // Count spawned child events
    const [spawnedRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(events)
      .where(eq(events.parentEventId, eventId))

    const spawnedCount = Number(spawnedRow?.count ?? 0)

    return {
      result: true,
      item: {
        id: event.id,
        projectId: event.projectId,
        agentId: event.agentId,
        agentPart,
        agentNickname,
        agentRole,
        agentOwnerName,
        type: event.type,
        parentEventId: event.parentEventId,
        spawnedAgentLabel: event.spawnedAgentLabel,
        detail: (event.detail ?? {}) as Record<string, unknown>,
        usage: event.usage,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        createdAt: event.createdAt,
        lineage,
        spawnedCount,
      },
    }
  } catch (err) {
    console.error("[getEvent]", err)
    return { result: false, message: "이벤트 정보를 불러오는 데 실패했습니다." }
  }
}
