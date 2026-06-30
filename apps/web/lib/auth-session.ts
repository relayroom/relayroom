import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"
import { and, count, eq } from "drizzle-orm"
import { auth } from "./auth"
import { db } from "./db"
import {
  better_auth_user,
  better_auth_member,
  better_auth_invitation,
} from "@relayroom/db/auth-schema"
import { projectAccess } from "@relayroom/db/schema"
import { SIGN_IN_PATH, PENDING_PATH } from "@/constants/service"

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
