import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"
import { and, count, eq, sql, type AnyColumn, type SQL } from "drizzle-orm"
import { auth } from "./auth"
import { db } from "./db"
import {
  better_auth_user,
  better_auth_member,
  better_auth_invitation,
} from "@relayroom/db/auth-schema"
import { projects, projectAccess } from "@relayroom/db/schema"
import { decideProjectAccess, type ProjectAccessLevel } from "@relayroom/shared"
import { SIGN_IN_PATH, PENDING_PATH } from "@/constants/service"
import { getErrorTranslations } from "./action-i18n"

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>

export const getServerSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() })
})

export async function requireSession() {
  const session = await getServerSession()
  if (!session) redirect(SIGN_IN_PATH)
  return session
}

/**
 * Guard for the dashboard. Requires an authenticated session AND an approved
 * role/membership.
 *
 * Approved if:
 *   - role === 'admin', OR
 *   - the user is a member of at least one organization (accepted invitation)
 *
 * Non-members (stray accounts) are redirected to /account/pending.
 * Public sign-up is now closed (disableSignUp: true in auth.ts), so stray
 * accounts should not arise in normal usage.
 */
export async function requireDashboardAccess() {
  const session = await requireSession()
  const role = (session.user as { role?: string }).role

  if (role === "admin") return session

  // Check org membership
  const [row] = await db
    .select({ n: count() })
    .from(better_auth_member)
    .where(eq(better_auth_member.userId, session.user.id))

  if ((row?.n ?? 0) > 0) return session

  redirect(PENDING_PATH)
}

/**
 * Whether at least one admin exists. This is the predicate that gates the one-time
 * bootstrap: setup stays reachable until an admin actually exists, so a stranded
 * "users-but-no-admin" install (e.g. signup succeeded but promotion failed) can self-heal
 * instead of being permanently locked out.
 */
export const adminExists = cache(async () => {
  const [row] = await db
    .select({ n: count() })
    .from(better_auth_user)
    .where(eq(better_auth_user.role, "admin"))
  return (row?.n ?? 0) > 0
})

// ── Organization helpers ─────────────────────────────────────────────────────

/**
 * List all organizations the current user belongs to.
 * Returns [] if the user has no session or no memberships.
 */
export const getOrganizations = cache(async () => {
  try {
    const result = await auth.api.listOrganizations({ headers: await headers() })
    return result ?? []
  } catch {
    return []
  }
})

/**
 * Fetch the full active organization (with members list) for server components.
 * Returns null if there is no active organization.
 */
export const getActiveOrganization = cache(async () => {
  try {
    const result = await auth.api.getFullOrganization({ headers: await headers() })
    return result ?? null
  } catch {
    return null
  }
})

/**
 * The current user's role in their active organization, or null if there is no
 * session / no active org / no membership. Resolved from better_auth_member by
 * (activeOrganizationId, userId).
 */
export const getActiveOrgRole = cache(async (): Promise<string | null> => {
  const session = await getServerSession()
  if (!session) return null
  const activeOrgId = (session.session as { activeOrganizationId?: string })
    .activeOrganizationId
  if (!activeOrgId) return null

  const [row] = await db
    .select({ role: better_auth_member.role })
    .from(better_auth_member)
    .where(
      and(
        eq(better_auth_member.organizationId, activeOrgId),
        eq(better_auth_member.userId, session.user.id),
      ),
    )
  return row?.role ?? null
})

/** Whether the current user manages the active org (owner or admin). */
export const isActiveOrgManager = cache(async (): Promise<boolean> => {
  const role = await getActiveOrgRole()
  return role === "owner" || role === "admin"
})

/**
 * List pending invitations for the active organization.
 *
 * SECURITY: invitation ids are account-claiming links — anyone with the id can
 * create the invitee's account. better-auth's listInvitations returns invites to
 * ANY member, so we additionally gate this on the caller being an owner/admin of
 * the active org. Non-managers get [] even if invitations exist.
 */
export const getActiveOrgInvitations = cache(async () => {
  if (!(await isActiveOrgManager())) return []
  try {
    const result = await auth.api.listInvitations({ headers: await headers() })
    // listInvitations returns ALL invitations (incl. accepted/canceled/expired).
    // The UI renders live copy/cancel controls, so only show truly-pending invites:
    // status === 'pending' AND not yet expired.
    const now = Date.now()
    return (result ?? []).filter(
      (inv) =>
        inv.status === "pending" && new Date(inv.expiresAt).getTime() > now,
    )
  } catch {
    return []
  }
})

// ── Org-scoped helpers (for viewing a specific org, not necessarily the active one) ──

/**
 * The current user's role in the given organization, or null if there is no
 * session / no membership in that org. Unlike getActiveOrgRole, this is scoped
 * to an explicit orgId so it works when viewing a non-active org.
 */
export const getOrgRole = cache(
  async (orgId: string): Promise<string | null> => {
    const session = await getServerSession()
    if (!session) return null

    const [row] = await db
      .select({ role: better_auth_member.role })
      .from(better_auth_member)
      .where(
        and(
          eq(better_auth_member.organizationId, orgId),
          eq(better_auth_member.userId, session.user.id),
        ),
      )
    return row?.role ?? null
  },
)

/** Whether the current user is a member of the given org (any role). */
export const isOrgMember = cache(async (orgId: string): Promise<boolean> => {
  return (await getOrgRole(orgId)) !== null
})

/** Whether the current user manages the given org (owner or admin). */
export const isOrgManager = cache(async (orgId: string): Promise<boolean> => {
  const role = await getOrgRole(orgId)
  return role === "owner" || role === "admin"
})

/**
 * Whether the given user is currently banned from the given project
 * (project_access.bannedAt is non-null). This is the AUTHORITATIVE project-scope ban
 * gate on the web side - mirror of the gate in mcp.ts resolveConnection. A project ban
 * must cut a member off on the dashboard too (reads, writes, live SSE), not just on the
 * agent bus, or the ban is merely cosmetic for anyone using the web UI. Returns false
 * for a user with no project_access row (not banned).
 */
export const isBannedFromProject = cache(
  async (projectId: string, userId: string): Promise<boolean> => {
    const [row] = await db
      .select({ bannedAt: projectAccess.bannedAt })
      .from(projectAccess)
      .where(
        and(
          eq(projectAccess.projectId, projectId),
          eq(projectAccess.userId, userId),
        ),
      )
      .limit(1)
    return row?.bannedAt != null
  },
)

/**
 * SQL predicate form of `isBannedFromProject`, negated: true for projects the
 * user is NOT banned from.
 *
 * `isBannedFromProject` answers for ONE known project, so it fits a page/action
 * gate that has already resolved which project it is about. It does not fit a
 * listing, where the project set is what the query is computing - checking it per
 * row means a round trip per row, and the rows must be filtered inside the query
 * anyway so that LIMIT and counts stay correct. This is the same rule expressed
 * where a list query can apply it.
 *
 * Pass the `project.id` column of the query being filtered.
 */
export function notBannedFromProject(
  projectIdColumn: AnyColumn | SQL,
  userId: string,
): SQL {
  return sql`not exists (
    select 1 from ${projectAccess}
    where ${projectAccess.projectId} = ${projectIdColumn}
      and ${projectAccess.userId} = ${userId}
      and ${projectAccess.bannedAt} is not null
  )`
}

/**
 * Authorize a project MUTATION by `project_access.level`, not merely org
 * membership (AC-1/AC-2). `requireOrgAccess`-style helpers only proved the caller
 * belonged to the active org, so any member - including a `readonly` grant - could
 * call updateProject/archiveProject/regenerateConnectCode/connectAgent. This
 * resolves the project's OWN organization (not the caller's "active org" tab),
 * confirms org membership there, rejects a project-scope ban, then requires the
 * caller's `project_access.level` to be at least `minLevel`.
 *
 * Org owners/admins are treated as effective project owners (mirrors
 * `requireProjectManage` in modules/project/member-actions.ts) so an org
 * owner/admin is never locked out of a project they administer just because
 * nobody granted them an explicit project_access row.
 *
 * Takes `userId` rather than resolving the session itself: callers already
 * hold a verified session (they call `getServerSession()` beforehand), and
 * keeping session resolution out of this function means it depends only on
 * its (mockable, cross-module) inputs in tests.
 *
 * The rule itself now lives in `decideProjectAccess` (@relayroom/shared), so the
 * MCP server can apply the same one. It could not import this function: this is
 * Next-bound - it resolves translations and uses the web app's db handle - which
 * is why a project-level gate was previously impossible to add server-side. What
 * stays here is everything that is web-specific: looking the facts up, and
 * turning a refusal into a translated message.
 */
export async function requireProjectAccess(
  userId: string,
  projectId: string,
  minLevel: ProjectAccessLevel,
): Promise<
  | { ok: true; orgId: string; level: ProjectAccessLevel }
  | { ok: false; message: string }
> {
  const t = await getErrorTranslations()

  const [project] = await db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) return { ok: false, message: t("project.notFound") }

  // The grant row carries both facts the decision needs about this project, so
  // it is read once: a ban and a level taken from two reads could disagree.
  const [[member], [grant]] = await Promise.all([
    db
      .select({ role: better_auth_member.role })
      .from(better_auth_member)
      .where(
        and(
          eq(better_auth_member.organizationId, project.organizationId),
          eq(better_auth_member.userId, userId),
        ),
      )
      .limit(1),
    db
      .select({ level: projectAccess.level, bannedAt: projectAccess.bannedAt })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))
      .limit(1),
  ])

  const decision = decideProjectAccess(
    { orgRole: member?.role, bannedAt: grant?.bannedAt, grantLevel: grant?.level },
    minLevel,
  )

  if (!decision.ok) {
    // The shared rule returns a reason, not copy - that is what lets the server
    // reuse it. Turning reasons into text is this layer's job.
    const message =
      decision.reason === "not_org_member"
        ? t("auth.noOrgAccess")
        : decision.reason === "banned"
          ? t("project.banned")
          : t("project.accessDenied")
    return { ok: false, message }
  }

  return { ok: true, orgId: project.organizationId, level: decision.level }
}

/**
 * List pending invitations for a SPECIFIC organization (the one being viewed).
 *
 * SECURITY: invitation ids are account-claiming links — anyone with the id can
 * create the invitee's account. So this is gated on the caller being an
 * owner/admin OF THAT org. Non-managers get [] even if invitations exist.
 *
 * Scoped directly against better_auth_invitation by organizationId so it is
 * correct regardless of which org is currently active in the session.
 */
export const getOrgInvitations = cache(async (orgId: string) => {
  if (!(await isOrgManager(orgId))) return []
  try {
    const rows = await db
      .select({
        id: better_auth_invitation.id,
        email: better_auth_invitation.email,
        role: better_auth_invitation.role,
        status: better_auth_invitation.status,
        expiresAt: better_auth_invitation.expiresAt,
      })
      .from(better_auth_invitation)
      .where(eq(better_auth_invitation.organizationId, orgId))

    // Only show truly-pending invites: status === 'pending' AND not yet expired.
    const now = Date.now()
    return rows.filter(
      (inv) =>
        inv.status === "pending" && new Date(inv.expiresAt).getTime() > now,
    )
  } catch {
    return []
  }
})
