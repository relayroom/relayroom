/**
 * Resolve the active organization ID for the current user.
 *
 * Priority:
 *   1. session.session.activeOrganizationId (user explicitly switched)
 *   2. First org the user belongs to (fallback for solo users who never switched)
 *   3. null — user has no org membership at all
 *
 * Callers should redirect to org creation if null is returned and they need an org.
 */

import { cache } from "react"
import { getServerSession, getOrganizations } from "./auth-session"

export const resolveActiveOrgId = cache(async (): Promise<string | null> => {
  const session = await getServerSession()
  if (!session) return null

  const activeOrgId = (session.session as { activeOrganizationId?: string }).activeOrganizationId
  if (activeOrgId) return activeOrgId

  // Fallback: first org
  const orgs = await getOrganizations()
  return (orgs[0] as { id: string } | undefined)?.id ?? null
})
