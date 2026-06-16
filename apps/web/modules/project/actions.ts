"use server"

import { randomBytes } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import type { ApiResult, ApiResultWithItem } from "@relayroom/shared"
import {
  createProjectSchema,
  type CreateProjectInput,
  updateProjectSchema,
  type UpdateProjectInput,
  updateRelayroomMdSchema,
  type UpdateRelayroomMdInput,
} from "./schema"
import { db } from "@/modules/drizzle/db"
import { projects, projectAccess } from "@relayroom/db/schema"
import { better_auth_member } from "@relayroom/db/auth-schema"
import { getServerSession } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getErrorTranslations } from "@/lib/action-i18n"
import { isUuid } from "@/lib/uuid"
import type { ProjectDetail } from "./queries"

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically strong connect_code.
 *
 * connect_code is a security credential used to authenticate agents into a
 * project, so it MUST NOT use Math.random (predictable). 24 random bytes →
 * url-safe base64 (~32 chars), high entropy.
 */
function generateConnectCode(): string {
  return randomBytes(24).toString("base64url")
}

type Session = NonNullable<Awaited<ReturnType<typeof getServerSession>>>

/**
 * Resolve and authorize the caller's active org for a mutation.
 *
 * Returns the orgId only when the caller is an authenticated member of that org
 * (verified against better_auth_member). This is the authorization anchor for
 * every project mutation: callers may only act within an org they belong to.
 */
async function requireOrgAccess(): Promise<
  | { ok: true; session: Session; orgId: string }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()
  const session = await getServerSession()
  if (!session) return { ok: false, message: t("auth.loginRequired") }

  const orgId = await resolveActiveOrgId()
  if (!orgId) return { ok: false, message: t("auth.orgRequired") }

  // Defense-in-depth: confirm the caller is actually a member of orgId.
  // (activeOrganizationId in the session is not, on its own, proof of membership.)
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

// ── createProject ─────────────────────────────────────────────────────────────

export async function createProject(
  input: CreateProjectInput,
): Promise<ApiResultWithItem<ProjectDetail>> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { session, orgId: activeOrgId } = access

    const parsed = createProjectSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const data = parsed.data

    // Check slug uniqueness within org
    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, activeOrgId),
          eq(projects.slug, data.slug),
          isNull(projects.archivedAt),
        ),
      )
      .limit(1)

    if (existing) {
      return { result: false, message: t("project.slugTaken", { slug: data.slug }) }
    }

    const connectCode = generateConnectCode()

    // Create the project AND its owner grant atomically. If the owner row failed
    // to insert as a separate statement, we would be left with an ownerless project
    // (nobody can administer it). One transaction => both commit or neither does.
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({
          organizationId: activeOrgId,
          slug: data.slug,
          name: data.name,
          summary: data.summary ?? null,
          description: data.description ?? null,
          thumbnailColor: data.thumbnailColor ?? null,
          backgroundColor: data.backgroundColor ?? null,
          thumbnailUrl: data.thumbnailUrl ?? null,
          backgroundUrl: data.backgroundUrl ?? null,
          connectCode,
          createdByUserId: session.user.id,
        })
        .returning()
      if (!created) throw new Error("project insert returned no row")

      // The creator is the project's first owner.
      await tx
        .insert(projectAccess)
        .values({ projectId: created.id, userId: session.user.id, level: "owner", createdByUserId: session.user.id })
        .onConflictDoNothing()

      return created
    })

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
      agentCount: 0,
      memberCount: 0,
    }

    return { result: true, item }
  } catch (err) {
    console.error("[createProject]", err)
    return { result: false, message: t("project.createFailed") }
  }
}

// ── updateProject ─────────────────────────────────────────────────────────────

export async function updateProject(
  input: UpdateProjectInput,
): Promise<ApiResultWithItem<{ id: string }>> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    const parsed = updateProjectSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const { projectId, ...fields } = parsed.data

    const [row] = await db
      .update(projects)
      .set({
        ...(fields.name !== undefined && { name: fields.name }),
        ...(fields.summary !== undefined && { summary: fields.summary }),
        ...(fields.description !== undefined && { description: fields.description }),
        ...(fields.thumbnailColor !== undefined && { thumbnailColor: fields.thumbnailColor }),
        ...(fields.backgroundColor !== undefined && { backgroundColor: fields.backgroundColor }),
        ...(fields.thumbnailUrl !== undefined && { thumbnailUrl: fields.thumbnailUrl }),
        ...(fields.backgroundUrl !== undefined && { backgroundUrl: fields.backgroundUrl }),
        ...(fields.conductor !== undefined && { conductor: fields.conductor }),
        updatedAt: new Date(),
      })
      // Scope to the caller's org so users can only mutate their own projects (IDOR guard).
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)))
      .returning({ id: projects.id })

    if (!row) return { result: false, message: t("project.notFound") }

    return { result: true, item: { id: row.id } }
  } catch (err) {
    console.error("[updateProject]", err)
    return { result: false, message: t("project.updateFailed") }
  }
}

// ── updateRelayroomMd ─────────────────────────────────────────────────────────

export async function updateRelayroomMd(
  input: UpdateRelayroomMdInput,
): Promise<ApiResultWithItem<{ id: string }>> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    const parsed = updateRelayroomMdSchema.safeParse(input)
    if (!parsed.success) {
      return { result: false, message: parsed.error.issues[0]?.message ?? t("common.invalidInput") }
    }

    const { projectId, content } = parsed.data
    const trimmed = content.trim()

    const [row] = await db
      .update(projects)
      // Empty content resets to the default template (null = serve default).
      .set({ relayroomMd: trimmed === "" ? null : content, updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)))
      .returning({ id: projects.id })

    if (!row) return { result: false, message: t("project.notFound") }
    return { result: true, item: { id: row.id } }
  } catch (err) {
    console.error("[updateRelayroomMd]", err)
    return { result: false, message: t("project.relayroomMdFailed") }
  }
}

// ── archiveProject ────────────────────────────────────────────────────────────

export async function archiveProject(projectId: string): Promise<ApiResult> {
  const t = await getErrorTranslations()
  try {
    if (!isUuid(projectId)) return { result: false, message: t("project.notFound") }
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    const [row] = await db
      .update(projects)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      // Scope to the caller's org (IDOR guard); reject if nothing matched.
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)))
      .returning({ id: projects.id })

    if (!row) return { result: false, message: t("project.notFound") }

    return { result: true }
  } catch (err) {
    console.error("[archiveProject]", err)
    return { result: false, message: t("project.archiveFailed") }
  }
}

// ── regenerateConnectCode ─────────────────────────────────────────────────────

export async function regenerateConnectCode(
  projectId: string,
): Promise<ApiResultWithItem<{ connectCode: string }>> {
  const t = await getErrorTranslations()
  try {
    const access = await requireOrgAccess()
    if (!access.ok) return { result: false, message: access.message }
    const { orgId } = access

    const connectCode = generateConnectCode()

    const [row] = await db
      .update(projects)
      .set({ connectCode, updatedAt: new Date() })
      // Scope to the caller's org (IDOR guard); reject if nothing matched.
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)))
      .returning({ connectCode: projects.connectCode })

    if (!row) return { result: false, message: t("project.notFound") }

    return { result: true, item: { connectCode: row.connectCode ?? connectCode } }
  } catch (err) {
    console.error("[regenerateConnectCode]", err)
    return { result: false, message: t("project.regenerateCodeFailed") }
  }
}

