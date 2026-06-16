import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { requireDashboardAccess, getServerSession } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import {
  getProjectMembers,
  getAddableOrgMembers,
  canManageMembers,
} from "@/modules/project/member-queries"
import { MembersManager } from "./members-manager"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ slug: string }>
}

export default async function ProjectMembersPage({ params }: Props) {
  await requireDashboardAccess()
  const { slug } = await params

  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()
  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()
  const project = projectResult.item

  const session = await getServerSession()
  const canManage = session
    ? await canManageMembers(orgId, project.id, session.user.id)
    : false

  const [membersRes, addableRes] = await Promise.all([
    getProjectMembers(project.id),
    canManage ? getAddableOrgMembers(orgId, project.id) : Promise.resolve({ result: true as const, totalCount: 0, items: [] }),
  ])
  const members = (membersRes.result ? membersRes.items : []).map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    level: m.level,
    isCreator: m.isCreator,
    bannedAt: m.bannedAt ? m.bannedAt.toISOString() : null,
  }))
  const addable = (addableRes.result ? addableRes.items : []).map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
  }))

  const t = await getTranslations("project.members")

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-4">
      <div>
        <h1 className="text-base font-semibold">{t("title")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <MembersManager
        projectId={project.id}
        members={members}
        addable={addable}
        canManage={canManage}
      />
    </div>
  )
}
