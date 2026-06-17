import { and, count, desc, eq, isNull, ne, sql } from "drizzle-orm"

// The virtual 'human' participant (server HUMAN_PART) is not a connectable agent,
// so it is excluded from dashboard agent counts and the status summary.
const HUMAN_PART = "human"
import type { ApiResultWithItem } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { projects, agents } from "@relayroom/db/schema"
import { better_auth_member } from "@relayroom/db/auth-schema"
import type { OrgCard } from "@/modules/organization/queries"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DashboardRecentProject {
  id: string
  slug: string
  name: string
  summary: string | null
  thumbnailColor: string | null
  agentCount: number
  createdAt: Date
}

export interface AgentStatusSummary {
  total: number
  connected: number
  offline: number
}

export interface DashboardSummary {
  projectCount: number
  recentProjects: DashboardRecentProject[]
  agentSummary: AgentStatusSummary
  orgCount: number
  orgs: Pick<OrgCard, "id" | "name" | "slug" | "role" | "memberCount">[]
}

// ── getDashboardSummary ───────────────────────────────────────────────────────

/**
 * Aggregates data for the dashboard home widgets.
 * - Recent 4 projects for the active org
 * - Agent count/status for those projects
 * - Org membership summary for the current user
 */
export async function getDashboardSummary(
  orgId: string,
  userId: string,
): Promise<ApiResultWithItem<DashboardSummary>> {
  try {
    // ── Project count + recent 4 ──────────────────────────────────────────
    const agentCountSq = db
      .select({
        projectId: agents.projectId,
        agentCount: count().as("agent_count"),
      })
      .from(agents)
      .where(and(isNull(agents.deletedAt), ne(agents.part, HUMAN_PART)))
      .groupBy(agents.projectId)
      .as("agent_counts")

    const projectRows = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        summary: projects.summary,
        thumbnailColor: projects.thumbnailColor,
        agentCount: sql<number>`coalesce(${agentCountSq.agentCount}, 0)`,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .leftJoin(agentCountSq, eq(projects.id, agentCountSq.projectId))
      .where(
        sql`${projects.organizationId} = ${orgId} and ${projects.archivedAt} is null`,
      )
      .orderBy(desc(projects.createdAt))

    const projectCount = projectRows.length
    const recentProjects: DashboardRecentProject[] = projectRows
      .slice(0, 4)
      .map((r) => ({ ...r, agentCount: Number(r.agentCount) }))

    // ── Agent status summary ──────────────────────────────────────────────
    // Collect project ids in this org
    const projectIds = projectRows.map((p) => p.id)

    let agentSummary: AgentStatusSummary = { total: 0, connected: 0, offline: 0 }
    if (projectIds.length > 0) {
      const agentRows = await db
        .select({ id: agents.id, lastSeenAt: agents.lastSeenAt })
        .from(agents)
        .where(
          and(
            projectIds.length === 1
              ? eq(agents.projectId, projectIds[0]!)
              : sql`${agents.projectId} = ANY(ARRAY[${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)}]::text[])`,
            isNull(agents.deletedAt),
            ne(agents.part, HUMAN_PART),
          ),
        )

      const now = Date.now()
      const CONNECTED_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
      let connected = 0
      for (const a of agentRows) {
        if (a.lastSeenAt && now - new Date(a.lastSeenAt).getTime() < CONNECTED_WINDOW_MS) {
          connected++
        }
      }
      agentSummary = {
        total: agentRows.length,
        connected,
        offline: agentRows.length - connected,
      }
    }

    // ── Org membership summary ────────────────────────────────────────────
    const memberships = await db
      .select({
        role: better_auth_member.role,
        organizationId: better_auth_member.organizationId,
      })
      .from(better_auth_member)
      .where(eq(better_auth_member.userId, userId))

    // We only fetch lightweight org data here (name/slug) — enough for the widget
    let orgs: DashboardSummary["orgs"] = []
    if (memberships.length > 0) {
      const { listMyOrganizations } = await import("@/modules/organization/queries")
      const orgResult = await listMyOrganizations(userId)
      if (orgResult.result) {
        orgs = orgResult.items.map((o) => ({
          id: o.id,
          name: o.name,
          slug: o.slug,
          role: o.role,
          memberCount: o.memberCount,
        }))
      }
    }

    const summary: DashboardSummary = {
      projectCount,
      recentProjects,
      agentSummary,
      orgCount: memberships.length,
      orgs,
    }

    return { result: true, item: summary }
  } catch (err) {
    console.error("[getDashboardSummary]", err)
    return { result: false, message: "대시보드 정보를 불러오는 데 실패했습니다." }
  }
}
