import { and, count, desc, eq, isNull, sql } from "drizzle-orm"
import type { ApiResultWithItem, ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { projects, agents, projectAccess, threads, events } from "@relayroom/db/schema"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectCard {
  id: string
  slug: string
  name: string
  summary: string | null
  thumbnailColor: string | null
  thumbnailUrl: string | null
  agentCount: number
  memberCount: number
  threadCount: number
  /** Most recent thread/event time - "last active" signal for the card. */
  lastActivityAt: Date | null
  /** Daily total tokens for the last 14 days (oldest first), for a sparkline. */
  usageSparkline: number[]
  createdAt: Date
}

const SPARKLINE_DAYS = 14

export interface ProjectDetail {
  id: string
  slug: string
  name: string
  summary: string | null
  description: string | null
  thumbnailColor: string | null
  thumbnailUrl: string | null
  backgroundColor: string | null
  backgroundUrl: string | null
  conductor: Record<string, unknown>
  connectCode: string | null
  relayroomMd: string | null
  maxBroadcastRecipients: number | null
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
  agentCount: number
  memberCount: number
}

// ── listProjects ──────────────────────────────────────────────────────────────

/**
 * List all non-archived projects for the given org.
 * Includes agent count and org member count (as proxy for member count since
 * project_access is an additional grant layer; v1 uses org member count).
 */
export async function listProjects(
  orgId: string,
): Promise<ApiResultWithItems<ProjectCard>> {
  try {
    // Agent counts per project
    const agentCountSq = db
      .select({
        projectId: agents.projectId,
        agentCount: count().as("agent_count"),
      })
      .from(agents)
      .groupBy(agents.projectId)
      .as("agent_counts")

    // Project member counts per project (project_access grants)
    const memberCountSq = db
      .select({
        projectId: projectAccess.projectId,
        memberCount: count().as("member_count"),
      })
      .from(projectAccess)
      .groupBy(projectAccess.projectId)
      .as("member_counts")

    // Thread count + last thread activity per project
    const threadStatsSq = db
      .select({
        projectId: threads.projectId,
        threadCount: count().as("thread_count"),
        lastThreadAt: sql<Date | null>`max(${threads.updatedAt})`.as("last_thread_at"),
      })
      .from(threads)
      .groupBy(threads.projectId)
      .as("thread_stats")

    // Last event (agent activity) per project
    const eventStatsSq = db
      .select({
        projectId: events.projectId,
        lastEventAt: sql<Date | null>`max(${events.createdAt})`.as("last_event_at"),
      })
      .from(events)
      .groupBy(events.projectId)
      .as("event_stats")

    const rows = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        summary: projects.summary,
        thumbnailColor: projects.thumbnailColor,
        thumbnailUrl: projects.thumbnailUrl,
        agentCount: sql<number>`coalesce(${agentCountSq.agentCount}, 0)`,
        memberCount: sql<number>`coalesce(${memberCountSq.memberCount}, 0)`,
        threadCount: sql<number>`coalesce(${threadStatsSq.threadCount}, 0)`,
        lastActivityAt: sql<Date | null>`greatest(${threadStatsSq.lastThreadAt}, ${eventStatsSq.lastEventAt})`,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .leftJoin(agentCountSq, eq(projects.id, agentCountSq.projectId))
      .leftJoin(memberCountSq, eq(projects.id, memberCountSq.projectId))
      .leftJoin(threadStatsSq, eq(projects.id, threadStatsSq.projectId))
      .leftJoin(eventStatsSq, eq(projects.id, eventStatsSq.projectId))
      .where(and(eq(projects.organizationId, orgId), isNull(projects.archivedAt)))
      .orderBy(desc(projects.createdAt))

    // Daily token totals per project for the last N days (one query → sparklines).
    const projectIds = rows.map((r) => r.id)
    const sparkMap = new Map<string, number[]>()
    if (projectIds.length > 0) {
      const days: string[] = []
      for (let i = SPARKLINE_DAYS - 1; i >= 0; i--) {
        days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
      }
      const dayIndex = new Map(days.map((d, i) => [d, i]))
      for (const id of projectIds) sparkMap.set(id, new Array(SPARKLINE_DAYS).fill(0))

      const idList = sql.join(projectIds.map((id) => sql`${id}`), sql`, `)
      const usageRows = await db.execute(sql`
        SELECT project_id,
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          COALESCE(SUM((usage->>'input_tokens')::numeric), 0)
            + COALESCE(SUM((usage->>'output_tokens')::numeric), 0) AS tokens
        FROM event
        WHERE project_id IN (${idList})
          AND usage IS NOT NULL
          AND created_at >= now() - (${SPARKLINE_DAYS} || ' days')::interval
        GROUP BY project_id, day
      `)
      for (const row of (usageRows.rows ?? []) as Array<{ project_id: string; day: string; tokens: string | number }>) {
        const idx = dayIndex.get(row.day)
        const arr = sparkMap.get(row.project_id)
        if (idx != null && arr) arr[idx] = Number(row.tokens)
      }
    }

    const items: ProjectCard[] = rows.map((r) => ({
      ...r,
      agentCount: Number(r.agentCount),
      memberCount: Number(r.memberCount),
      threadCount: Number(r.threadCount),
      lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt) : null,
      usageSparkline: sparkMap.get(r.id) ?? new Array(SPARKLINE_DAYS).fill(0),
    }))

    return { result: true, totalCount: items.length, items }
  } catch (err) {
    console.error("[listProjects]", err)
    return { result: false, message: "프로젝트 목록을 불러오는 데 실패했습니다." }
  }
}

// ── getProjectBySlug ──────────────────────────────────────────────────────────

export async function getProjectBySlug(
  orgId: string,
  slug: string,
): Promise<ApiResultWithItem<ProjectDetail>> {
  try {
    const [row] = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, orgId),
          eq(projects.slug, slug),
          isNull(projects.archivedAt),
        ),
      )
      .limit(1)

    if (!row) {
      return { result: false, message: "프로젝트를 찾을 수 없습니다." }
    }

    const [agentRow] = await db
      .select({ agentCount: count() })
      .from(agents)
      .where(eq(agents.projectId, row.id))

    const [memberRow] = await db
      .select({ memberCount: count() })
      .from(projectAccess)
      .where(eq(projectAccess.projectId, row.id))

    const item: ProjectDetail = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      description: row.description,
      thumbnailColor: row.thumbnailColor,
      thumbnailUrl: row.thumbnailUrl,
      backgroundColor: row.backgroundColor,
      backgroundUrl: row.backgroundUrl,
      conductor: row.conductor,
      connectCode: row.connectCode,
      relayroomMd: row.relayroomMd,
      maxBroadcastRecipients: row.maxBroadcastRecipients,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      agentCount: Number(agentRow?.agentCount ?? 0),
      memberCount: Number(memberRow?.memberCount ?? 0),
    }

    return { result: true, item }
  } catch (err) {
    console.error("[getProjectBySlug]", err)
    return { result: false, message: "프로젝트 정보를 불러오는 데 실패했습니다." }
  }
}
