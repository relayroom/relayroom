"use server"

import { and, count, eq, isNull } from "drizzle-orm"
import type { ApiResult } from "@relayroom/shared"
import {
  addProjectMemberSchema,
  type AddProjectMemberInput,
  updateProjectMemberSchema,
  type UpdateProjectMemberInput,
  removeProjectMemberSchema,
  type RemoveProjectMemberInput,
  banProjectMemberSchema,
  type BanProjectMemberInput,
  unbanProjectMemberSchema,
  type UnbanProjectMemberInput,
} from "./schema"
import { db } from "@/modules/drizzle/db"
import { projects, projectAccess, governanceAlerts, governanceAudits } from "@relayroom/db/schema"
import { applyBan, applyUnban } from "@relayroom/db/governance"
import { better_auth_member } from "@relayroom/db/auth-schema"
import { getServerSession } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getErrorTranslations } from "@/lib/action-i18n"

type Session = NonNullable<Awaited<ReturnType<typeof getServerSession>>>

async function requireOrgAccess(): Promise<
  | { ok: true; session: Session; orgId: string; role: string }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()
  const session = await getServerSession()
  if (!session) return { ok: false, message: t("auth.loginRequired") }
  const orgId = await resolveActiveOrgId()
  if (!orgId) return { ok: false, message: t("auth.orgRequired") }
  const [member] = await db
    .select({ role: better_auth_member.role })
    .from(better_auth_member)
    .where(and(eq(better_auth_member.organizationId, orgId), eq(better_auth_member.userId, session.user.id)))
    .limit(1)
  if (!member) return { ok: false, message: t("auth.noOrgAccess") }
  return { ok: true, session, orgId, role: member.role }
}

/**
 * Authorize a membership mutation on a project. Beyond org membership, the
 * caller must have management authority over THIS project - otherwise any
 * org member could grant themselves write access or remove others
 * (privilege escalation). Authority = org owner/admin, the project creator,
 * or an existing project member with `write` access.
 */
export async function requireProjectManage(
  projectId: string,
): Promise<
  | { ok: true; session: Session; orgId: string; createdByUserId: string | null }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()
  const access = await requireOrgAccess()
  if (!access.ok) return access
  const { session, orgId, role } = access

  const [row] = await db
    .select({ id: projects.id, createdByUserId: projects.createdByUserId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)))
    .limit(1)
  if (!row) return { ok: false, message: t("project.notFound") }

  // A member banned from THIS project loses ALL management authority, even if they
  // still hold an 'owner' project_access row or an org owner/admin role - otherwise a
  // banned owner could call unbanProjectMember on themselves and re-take the project
  // (governance takeover). They must be unbanned by another manager first.
  const [selfPa] = await db
    .select({ bannedAt: projectAccess.bannedAt })
    .from(projectAccess)
    .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, session.user.id)))
    .limit(1)
  if (selfPa?.bannedAt) return { ok: false, message: t("member.manageDenied") }

  // Org owners/admins manage any project; otherwise the caller must be a
  // project owner. Read/write members cannot change who has access.
  let canManage = role === "owner" || role === "admin"
  if (!canManage) {
    const [pa] = await db
      .select({ level: projectAccess.level })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, session.user.id)))
      .limit(1)
    canManage = pa?.level === "owner"
  }
  if (!canManage) return { ok: false, message: t("member.manageDenied") }

  return { ok: true, session, orgId, createdByUserId: row.createdByUserId }
}

/** The given member's current access level on the project (null if not a member). */
async function memberLevel(projectId: string, userId: string): Promise<string | null> {
  const [pa] = await db
    .select({ level: projectAccess.level })
    .from(projectAccess)
    .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))
    .limit(1)
  return pa?.level ?? null
}

/**
 * Number of EFFECTIVE owners on a project (a project must always keep at least one).
 * Banned owners are excluded: a banned member is not an effective owner, so they must
 * not satisfy last-owner protection (which would let the remaining real owner be
 * demoted/banned/removed and orphan the project).
 */
async function ownerCount(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(projectAccess)
    .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.level, "owner"), isNull(projectAccess.bannedAt)))
  return Number(row?.n ?? 0)
}

/** Confirm a user is a member of the org (so only org members can be added). */
async function isOrgMember(orgId: string, userId: string): Promise<boolean> {
  const [m] = await db
    .select({ id: better_auth_member.id })
    .from(better_auth_member)
    .where(and(eq(better_auth_member.organizationId, orgId), eq(better_auth_member.userId, userId)))
    .limit(1)
  return !!m
}

export async function addProjectMember(input: AddProjectMemberInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const parsed = addProjectMemberSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { projectId, userId, level } = parsed.data

    const access = await requireProjectManage(projectId)
    if (!access.ok) return { result: false, message: access.message }
    const { session, orgId } = access

    if (!(await isOrgMember(orgId, userId))) {
      return { result: false, message: t("member.orgMemberOnly") }
    }

    await db
      .insert(projectAccess)
      .values({ projectId, userId, level, createdByUserId: session.user.id })
      .onConflictDoUpdate({
        target: [projectAccess.projectId, projectAccess.userId],
        set: { level },
      })

    return { result: true }
  } catch (err) {
    console.error("[addProjectMember]", err)
    return { result: false, message: t("member.addFailed") }
  }
}

export async function updateProjectMemberLevel(input: UpdateProjectMemberInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const parsed = updateProjectMemberSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { projectId, userId, level } = parsed.data

    const access = await requireProjectManage(projectId)
    if (!access.ok) return { result: false, message: access.message }

    // A project must always keep at least one owner.
    if (level !== "owner" && (await memberLevel(projectId, userId)) === "owner" && (await ownerCount(projectId)) <= 1) {
      return { result: false, message: t("member.lastOwnerLevel") }
    }

    await db
      .update(projectAccess)
      .set({ level })
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))

    return { result: true }
  } catch (err) {
    console.error("[updateProjectMemberLevel]", err)
    return { result: false, message: t("member.updateFailed") }
  }
}

export async function removeProjectMember(input: RemoveProjectMemberInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const parsed = removeProjectMemberSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { projectId, userId } = parsed.data

    const access = await requireProjectManage(projectId)
    if (!access.ok) return { result: false, message: access.message }

    // A project must always keep at least one owner.
    if ((await memberLevel(projectId, userId)) === "owner" && (await ownerCount(projectId)) <= 1) {
      return { result: false, message: t("member.lastOwnerRemove") }
    }

    await db
      .delete(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))

    return { result: true }
  } catch (err) {
    console.error("[removeProjectMember]", err)
    return { result: false, message: t("member.removeFailed") }
  }
}

// ── Governance ban / unban (phase 09) ─────────────────────────────────────────

/** Project ids belonging to an org (org-scope ban targets each of them). */
async function projectIdsInOrg(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, orgId))
  return rows.map((r) => r.id)
}

/**
 * Reversibly ban a project member: sets project_access.bannedAt (NOT a hard
 * delete), revokes their agent connections, invalidates their MCP tokens, and
 * cancels+refunds their parts' pending wakes. Manager-only. The last owner of a
 * project cannot be banned (org scope checks every project). Self-ban is refused.
 * Related open governance alerts are marked resolved (audit linkage).
 */
export async function banProjectMember(input: BanProjectMemberInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const parsed = banProjectMemberSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { projectId, userId, scope } = parsed.data

    const access = await requireProjectManage(projectId)
    if (!access.ok) return { result: false, message: access.message }
    const { session, orgId } = access

    // A manager cannot lock themselves out by accident.
    if (userId === session.user.id) {
      return { result: false, message: t("member.selfBan") }
    }

    // last-owner protection: the last owner of a project cannot be banned. Org
    // scope must check this on EVERY target project.
    const targetProjects = scope === "org" ? await projectIdsInOrg(orgId) : [projectId]
    for (const pid of targetProjects) {
      if ((await memberLevel(pid, userId)) === "owner" && (await ownerCount(pid)) <= 1) {
        return { result: false, message: t("member.lastOwnerBan") }
      }
    }

    const result = await applyBan(db, {
      projectId,
      userId,
      scope: { kind: scope },
      bannedByUserId: session.user.id,
      orgId,
    })

    // Resolve related open alerts (08 linkage) + write an append-only audit row.
    await db
      .update(governanceAlerts)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(governanceAlerts.projectId, projectId),
          eq(governanceAlerts.subjectUserId, userId),
          isNull(governanceAlerts.resolvedAt),
        ),
      )

    await db.insert(governanceAudits).values({
      projectId,
      orgId,
      action: "ban",
      scope,
      subjectUserId: userId,
      actorUserId: session.user.id,
      detail: { ...result },
    })

    return { result: true }
  } catch (err) {
    console.error("[banProjectMember]", err)
    return { result: false, message: t("member.banFailed") }
  }
}

/**
 * Reverse a ban: clears project_access.bannedAt. Does NOT auto-reconnect agents -
 * the member runs `relayroom connect` again. Manager-only; no last-owner or
 * self guard (unban does not remove authority).
 */
export async function unbanProjectMember(input: UnbanProjectMemberInput): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    const parsed = unbanProjectMemberSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }
    const { projectId, userId, scope } = parsed.data

    const access = await requireProjectManage(projectId)
    if (!access.ok) return { result: false, message: access.message }
    const { session, orgId } = access

    await applyUnban(db, { projectId, userId, scope: { kind: scope }, orgId })

    await db.insert(governanceAudits).values({
      projectId,
      orgId,
      action: "unban",
      scope,
      subjectUserId: userId,
      actorUserId: session.user.id,
      detail: {},
    })

    return { result: true }
  } catch (err) {
    console.error("[unbanProjectMember]", err)
    return { result: false, message: t("member.unbanFailed") }
  }
}
