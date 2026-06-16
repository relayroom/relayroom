import { and, count, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { ApiResultWithItems } from "@relayroom/shared"
import { NEEDS_HUMAN_TAG } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { governanceAlerts, projects, projectAccess, threads, agents } from "@relayroom/db/schema"
import { better_auth_member, better_auth_user } from "@relayroom/db/auth-schema"

/**
 * Number of open threads across an org's projects.
 *
 * In an observe/steer product the bell surfaces "things waiting on a human":
 * threads still in the `open` state (an agent or teammate is awaiting a
 * response). Scoped to the org, so it reflects the active workspace. Returns 0
 * on any error so the topbar never breaks.
 */
export async function getOpenThreadCount(orgId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ n: count() })
      .from(threads)
      .innerJoin(projects, eq(threads.projectId, projects.id))
      .where(and(eq(projects.organizationId, orgId), eq(threads.status, "open")))
    return row?.n ?? 0
  } catch (err) {
    console.error("[getOpenThreadCount]", err)
    return 0
  }
}

/**
 * Number of threads needing a human across an org's projects — the ONLY signal
 * the notification bell counts. A thread "needs a human" when an agent flagged
 * it (the `needs-human` tag) and it is not closed/canceled. Cleared when a human
 * replies (auto) or dismisses it. Distinct from getOpenThreadCount, which is the
 * ambient, agent-driven activity metric shown in the sidebar.
 */
export async function getAttentionCount(orgId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ n: count() })
      .from(threads)
      .innerJoin(projects, eq(threads.projectId, projects.id))
      .where(
        and(
          eq(projects.organizationId, orgId),
          notInArray(threads.status, ["closed", "canceled"]),
          sql`${NEEDS_HUMAN_TAG} = ANY(${threads.tags})`,
        ),
      )
    return row?.n ?? 0
  } catch (err) {
    console.error("[getAttentionCount]", err)
    return 0
  }
}

export interface InboxThread {
  id: string
  subject: string
  status: string
  tags: string[]
  projectSlug: string
  projectName: string
  createdAt: Date
  updatedAt: Date
  /** Part of the agent that opened the thread (null if a human opened it). */
  createdByAgentPart: string | null
  /** True when a human (not an agent) opened the thread. */
  createdByHuman: boolean
  /** Total messages in the thread (1 = just posted; >1 = a conversation). */
  messageCount: number
  /** Part of the agent who sent the most recent message (null if human/none). */
  lastActorPart: string | null
  /** True when the most recent message was from a human. */
  lastActorHuman: boolean
}

const creator = alias(agents, "creator")

/**
 * Shared enriched select for inbox rows. Adds who opened the thread, the message
 * count, and who spoke last — so the inbox can show, per thread, which project
 * and agent it belongs to and whether it is a fresh question or an ongoing
 * conversation. Caller supplies the WHERE condition.
 */
async function selectInboxThreads(where: SQL): Promise<InboxThread[]> {
  return db
    .select({
      id: threads.id,
      subject: threads.subject,
      status: threads.status,
      tags: threads.tags,
      projectSlug: projects.slug,
      projectName: projects.name,
      createdAt: threads.createdAt,
      updatedAt: threads.updatedAt,
      createdByAgentPart: creator.part,
      createdByHuman: sql<boolean>`${threads.createdByUserId} is not null`,
      messageCount: sql<number>`(select count(*)::int from message m where m.thread_id = ${threads.id})`,
      lastActorPart: sql<string | null>`(select a.part from message m left join agent a on a.id = m.from_agent_id where m.thread_id = ${threads.id} order by m.created_at desc limit 1)`,
      lastActorHuman: sql<boolean>`coalesce((select (m.from_user_id is not null) from message m where m.thread_id = ${threads.id} order by m.created_at desc limit 1), false)`,
    })
    .from(threads)
    .innerJoin(projects, eq(threads.projectId, projects.id))
    .leftJoin(creator, eq(threads.createdByAgentId, creator.id))
    .where(where)
    .orderBy(desc(threads.updatedAt))
    .limit(100)
}

/**
 * Open threads across an org's projects, newest activity first. Backs the
 * "Open threads" section of /inbox (ambient, agent-driven activity).
 */
export async function getOpenThreadsForOrg(
  orgId: string,
): Promise<ApiResultWithItems<InboxThread>> {
  try {
    const rows = await selectInboxThreads(
      and(eq(projects.organizationId, orgId), eq(threads.status, "open"))!,
    )
    return { result: true, totalCount: rows.length, items: rows }
  } catch (err) {
    console.error("[getOpenThreadsForOrg]", err)
    return { result: false, message: "수신함을 불러오는 데 실패했습니다." }
  }
}

// ── Governance alerts (phase 08) ─────────────────────────────────────────────
// Risk patterns the server-side detector flagged for a MANAGER to review. These
// merge into the same "attention" lane as needs-human, but visibility is gated:
// only managers (org owner/admin, or a project owner) see them, enforced HERE in
// the query (UI hiding alone is not enough).

export interface GovernanceAlertRow {
  id: string
  projectId: string
  projectSlug: string
  projectName: string
  subjectUserId: string | null
  subjectName: string | null
  subjectEmail: string | null
  kind: string
  detail: Record<string, unknown>
  createdAt: Date
}

/**
 * Project ids in this org the user may manage (and therefore see governance
 * alerts for). Mirrors `canManageMembers`: org owners/admins manage EVERY project
 * in the org; otherwise only projects where the user holds `owner` project_access.
 * Returns [] for a non-manager (so all downstream governance reads are empty).
 */
export async function getManagedProjectIds(orgId: string, userId: string): Promise<string[]> {
  try {
    const [m] = await db
      .select({ role: better_auth_member.role })
      .from(better_auth_member)
      .where(and(eq(better_auth_member.organizationId, orgId), eq(better_auth_member.userId, userId)))
      .limit(1)

    if (m && (m.role === "owner" || m.role === "admin")) {
      const all = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.organizationId, orgId))
      return all.map((r) => r.id)
    }

    // Not an org manager: only projects in this org where the user is a project owner.
    const owned = await db
      .select({ id: projects.id })
      .from(projectAccess)
      .innerJoin(projects, eq(projectAccess.projectId, projects.id))
      .where(
        and(
          eq(projects.organizationId, orgId),
          eq(projectAccess.userId, userId),
          eq(projectAccess.level, "owner"),
        ),
      )
    return owned.map((r) => r.id)
  } catch (err) {
    console.error("[getManagedProjectIds]", err)
    return []
  }
}

/**
 * Count of OPEN governance alerts the user (as a manager) should act on. Merged
 * into the bell's attention count. Non-managers get 0. Returns 0 on any error so
 * the topbar never breaks.
 */
export async function getGovernanceAlertCount(orgId: string, userId: string): Promise<number> {
  try {
    const ids = await getManagedProjectIds(orgId, userId)
    if (ids.length === 0) return 0
    const [row] = await db
      .select({ n: count() })
      .from(governanceAlerts)
      .where(and(inArray(governanceAlerts.projectId, ids), isNull(governanceAlerts.resolvedAt)))
    return row?.n ?? 0
  } catch (err) {
    console.error("[getGovernanceAlertCount]", err)
    return 0
  }
}

/**
 * Open governance alert rows for the manager's projects, joined with project and
 * subject (the flagged member). Non-managers get an empty list. Newest first.
 */
export async function getGovernanceAlertsForManager(
  orgId: string,
  userId: string,
): Promise<ApiResultWithItems<GovernanceAlertRow>> {
  try {
    const ids = await getManagedProjectIds(orgId, userId)
    if (ids.length === 0) return { result: true, totalCount: 0, items: [] }

    const rows = await db
      .select({
        id: governanceAlerts.id,
        projectId: governanceAlerts.projectId,
        projectSlug: projects.slug,
        projectName: projects.name,
        subjectUserId: governanceAlerts.subjectUserId,
        subjectName: better_auth_user.name,
        subjectNickname: better_auth_user.nickname,
        subjectEmail: better_auth_user.email,
        kind: governanceAlerts.kind,
        detail: governanceAlerts.detail,
        createdAt: governanceAlerts.createdAt,
      })
      .from(governanceAlerts)
      .innerJoin(projects, eq(governanceAlerts.projectId, projects.id))
      .leftJoin(better_auth_user, eq(governanceAlerts.subjectUserId, better_auth_user.id))
      .where(and(inArray(governanceAlerts.projectId, ids), isNull(governanceAlerts.resolvedAt)))
      .orderBy(desc(governanceAlerts.createdAt))
      .limit(100)

    const items: GovernanceAlertRow[] = rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      projectSlug: r.projectSlug,
      projectName: r.projectName,
      subjectUserId: r.subjectUserId,
      subjectName: (r.subjectNickname && r.subjectNickname.trim()) || r.subjectName,
      subjectEmail: r.subjectEmail,
      kind: r.kind,
      detail: r.detail ?? {},
      createdAt: r.createdAt,
    }))

    return { result: true, totalCount: items.length, items }
  } catch (err) {
    console.error("[getGovernanceAlertsForManager]", err)
    return { result: false, message: "거버넌스 알림을 불러오는 데 실패했습니다." }
  }
}

/**
 * Threads needing a human across an org's projects, newest activity first.
 * Backs the "Attention" section of /inbox (the bell's real queue): `needs-human`
 * tagged and not closed/canceled.
 */
export async function getAttentionThreadsForOrg(
  orgId: string,
): Promise<ApiResultWithItems<InboxThread>> {
  try {
    const rows = await selectInboxThreads(
      and(
        eq(projects.organizationId, orgId),
        notInArray(threads.status, ["closed", "canceled"]),
        sql`${NEEDS_HUMAN_TAG} = ANY(${threads.tags})`,
      )!,
    )
    return { result: true, totalCount: rows.length, items: rows }
  } catch (err) {
    console.error("[getAttentionThreadsForOrg]", err)
    return { result: false, message: "수신함을 불러오는 데 실패했습니다." }
  }
}
