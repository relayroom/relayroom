/**
 * Resolve the active organization ID for the current user.
 *
 * Priority:
 *   1. session.session.activeOrganizationId (user explicitly switched) - IF the
 *      caller is still actually a member of that org (AC-4). The session cookie's
 *      activeOrganizationId is not, on its own, proof of current membership: a
 *      member removed from an org after switching to it (or a stale/forged
 *      session value) must not keep resolving to that org.
 *   2. First org the user belongs to (fallback for solo users who never switched)
 *   3. null — user has no org membership at all
 *
 * Callers should redirect to org creation if null is returned and they need an org.
 */

import { cache } from "react"
import { getServerSession, getOrganizations, isOrgMember } from "./auth-session"

export const resolveActiveOrgId = cache(async (): Promise<string | null> => {
  const session = await getServerSession()
  if (!session) return null

  const activeOrgId = (session.session as { activeOrganizationId?: string }).activeOrganizationId
  if (activeOrgId && (await isOrgMember(activeOrgId))) return activeOrgId

  // Fallback: first org
  const orgs = await getOrganizations()
  return (orgs[0] as { id: string } | undefined)?.id ?? null
})
