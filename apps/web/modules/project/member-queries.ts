import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm"
import type { ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { projects, projectAccess } from "@relayroom/db/schema"
import { better_auth_member, better_auth_user } from "@relayroom/db/auth-schema"

export interface ConnectableProject {
  id: string
  slug: string
  name: string
  connectCode: string | null
}

/**
 * Projects the user can connect an agent to: those they are a member of with
 * write or owner access. Used by the global Agents page's add-agent dialog.
 */
export async function getConnectableProjects(userId: string): Promise<ConnectableProject[]> {
  try {
    return await db
      .select({ id: projects.id, slug: projects.slug, name: projects.name, connectCode: projects.connectCode })
      .from(projects)
      .innerJoin(projectAccess, eq(projectAccess.projectId, projects.id))
      .where(
        and(
          eq(projectAccess.userId, userId),
          inArray(projectAccess.level, ["write", "owner"]),
          sql`${projects.archivedAt} IS NULL`,
        ),
      )
      .orderBy(desc(projects.createdAt))
  } catch (err) {
    console.error("[getConnectableProjects]", err)
    return []
  }
}

export interface ProjectMember {
  userId: string
  name: string
  email: string
  /** project_access grant level: write | readonly | readonly_all */
  level: string
  /** True if this user created the project. */
  isCreator: boolean
  /** Non-null = banned from this project (reversible). Drives the ban/unban toggle. */
  bannedAt: Date | null
  createdAt: Date
}

export interface OrgMemberOption {
  userId: string
  name: string
  email: string
  /** org role: owner | admin | member */
  role: string
}

/**
 * Members granted access to a project (project_access rows), with display name
 * and email, newest grant last. The project creator is flagged so the UI can
 * mark them and prevent self-removal.
 */
export async function getProjectMembers(
  projectId: string,
): Promise<ApiResultWithItems<ProjectMember>> {
  try {
    const [createdBy] = await db
      .select({ createdByUserId: projects.createdByUserId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)

    const rows = await db
      .select({
        userId: projectAccess.userId,
        level: projectAccess.level,
        bannedAt: projectAccess.bannedAt,
        createdAt: projectAccess.createdAt,
        name: better_auth_user.name,
        email: better_auth_user.email,
        nickname: better_auth_user.nickname,
      })
      .from(projectAccess)
      .innerJoin(better_auth_user, eq(projectAccess.userId, better_auth_user.id))
      .where(eq(projectAccess.projectId, projectId))
      .orderBy(asc(projectAccess.createdAt))

    const items: ProjectMember[] = rows.map((r) => ({
      userId: r.userId,
      name: (r.nickname && r.nickname.trim()) || r.name,
      email: r.email,
      level: r.level,
      isCreator: r.userId === createdBy?.createdByUserId,
      bannedAt: r.bannedAt,
      createdAt: r.createdAt,
    }))

    return { result: true, totalCount: items.length, items }
  } catch (err) {
    console.error("[getProjectMembers]", err)
    return { result: false, message: "멤버 목록을 불러오는 데 실패했습니다." }
  }
}

/**
 * Whether the given user may manage this project's membership: org owners/admins,
 * or a project member with `owner` access. Read/write members cannot. Mirrors the
 * server-side requireProjectManage authority check so the UI can hide controls.
 */
export async function canManageMembers(
  orgId: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  try {
    const [m] = await db
      .select({ role: better_auth_member.role })
      .from(better_auth_member)
      .where(and(eq(better_auth_member.organizationId, orgId), eq(better_auth_member.userId, userId)))
      .limit(1)
    if (m && (m.role === "owner" || m.role === "admin")) return true

    const [pa] = await db
      .select({ level: projectAccess.level })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))
      .limit(1)
    return pa?.level === "owner"
  } catch (err) {
    console.error("[canManageMembers]", err)
    return false
  }
}

/**
 * Org members who are NOT yet project members - the candidates an admin can add
 * to this project.
 */
export async function getAddableOrgMembers(
  orgId: string,
  projectId: string,
): Promise<ApiResultWithItems<OrgMemberOption>> {
  try {
    const existing = db
      .select({ userId: projectAccess.userId })
      .from(projectAccess)
      .where(eq(projectAccess.projectId, projectId))

    const rows = await db
      .select({
        userId: better_auth_member.userId,
        role: better_auth_member.role,
        name: better_auth_user.name,
        email: better_auth_user.email,
        nickname: better_auth_user.nickname,
      })
      .from(better_auth_member)
      .innerJoin(better_auth_user, eq(better_auth_member.userId, better_auth_user.id))
      .where(
        and(
          eq(better_auth_member.organizationId, orgId),
          notInArray(better_auth_member.userId, existing),
        ),
      )
      .orderBy(asc(sql`lower(${better_auth_user.name})`))

    const items: OrgMemberOption[] = rows.map((r) => ({
      userId: r.userId,
      name: (r.nickname && r.nickname.trim()) || r.name,
      email: r.email,
      role: r.role,
    }))

    return { result: true, totalCount: items.length, items }
  } catch (err) {
    console.error("[getAddableOrgMembers]", err)
    return { result: false, message: "조직 멤버를 불러오는 데 실패했습니다." }
  }
}
