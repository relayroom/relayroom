import { count, eq, inArray } from "drizzle-orm"
import type { ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { better_auth_member, better_auth_organization } from "@relayroom/db/auth-schema"
import { getErrorTranslations } from "@/lib/action-i18n"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrgCard {
  id: string
  name: string
  slug: string | null
  logo: string | null
  role: string
  memberCount: number
  createdAt: Date
}

// ── listMyOrganizations ───────────────────────────────────────────────────────

/**
 * List all organizations the given user belongs to, with their role and
 * member count.
 */
export async function listMyOrganizations(
  userId: string,
): Promise<ApiResultWithItems<OrgCard>> {
  const t = await getErrorTranslations()
  try {
    // All memberships for this user
    const memberships = await db
      .select({
        role: better_auth_member.role,
        organizationId: better_auth_member.organizationId,
      })
      .from(better_auth_member)
      .where(eq(better_auth_member.userId, userId))

    if (memberships.length === 0) {
      return { result: true, totalCount: 0, items: [] }
    }

    const orgIds = memberships.map((m) => m.organizationId)
    const roleByOrgId = Object.fromEntries(memberships.map((m) => [m.organizationId, m.role]))

    // Fetch org rows
    const orgs = await db
      .select({
        id: better_auth_organization.id,
        name: better_auth_organization.name,
        slug: better_auth_organization.slug,
        logo: better_auth_organization.logo,
        createdAt: better_auth_organization.createdAt,
      })
      .from(better_auth_organization)
      .where(
        orgIds.length === 1
          ? eq(better_auth_organization.id, orgIds[0]!)
          : inArray(better_auth_organization.id, orgIds),
      )

    // Member counts per org
    const memberCounts = await db
      .select({
        organizationId: better_auth_member.organizationId,
        memberCount: count(),
      })
      .from(better_auth_member)
      .where(
        orgIds.length === 1
          ? eq(better_auth_member.organizationId, orgIds[0]!)
          : inArray(better_auth_member.organizationId, orgIds),
      )
      .groupBy(better_auth_member.organizationId)

    const countByOrgId = Object.fromEntries(
      memberCounts.map((r) => [r.organizationId, Number(r.memberCount)]),
    )

    const items: OrgCard[] = orgs.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo,
      role: roleByOrgId[org.id] ?? "member",
      memberCount: countByOrgId[org.id] ?? 1,
      createdAt: org.createdAt,
    }))

    // Sort newest first
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    return { result: true, totalCount: items.length, items }
  } catch (err) {
    console.error("[listMyOrganizations]", err)
    return { result: false, message: t("organization.listFailed") }
  }
}
