import type { ReactNode } from "react"
import { notFound } from "next/navigation"
import { requireDashboardAccess, isOrgMember, isBannedFromProject } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug, listProjects } from "@/modules/project/queries"
import { RealtimeProvider } from "@/components/realtime/realtime-provider"
import { ProjectBreadcrumbSetter } from "@/components/layouts/app/project-breadcrumb-setter"
import { StickyTabHeader } from "@/components/layouts/app/sticky-tab-header"
import { ProjectTabBar } from "./project-tab-bar"

export const dynamic = "force-dynamic"

interface Props {
  children: ReactNode
  params: Promise<{ slug: string }>
}

export default async function ProjectLayout({ children, params }: Props) {
  const session = await requireDashboardAccess()

  const { slug } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  // AC-4: re-confirm the caller is STILL a member of orgId before serving project
  // data. resolveActiveOrgId's session-stored `activeOrganizationId` path returns
  // whatever org tab was active when the session cookie was minted, without
  // proving current membership - if the member is later removed from the org (or
  // never belonged to it), a stale/forged activeOrganizationId must not leak read
  // access to that org's project. A removed member gets a 404, not the project.
  if (!(await isOrgMember(orgId))) notFound()

  const result = await getProjectBySlug(orgId, slug)
  if (!result.result) notFound()

  const project = result.item

  // A project-scope ban has to cut READS too, not just writes and the live SSE
  // stream. Those two were already gated (modules/thread/actions.ts,
  // app/api/realtime/route.ts) while every server-rendered read under this
  // layout was not, so a banned member who simply reloaded the page kept seeing
  // the whole project - threads and their bodies, events, agents, usage, and the
  // connect_code that the overview hands to AgentRegisterDialog. Gating here
  // covers every tab at once, because they all render inside this layout.
  if (await isBannedFromProject(project.id, session.user.id)) notFound()

  // Sibling projects for the topbar breadcrumb switcher.
  const listResult = await listProjects(orgId, session.user.id)
  const projects = listResult.result ? listResult.items : []

  return (
    <RealtimeProvider projectId={project.id}>
    <div className="flex flex-col">
      {/* Push the project breadcrumb into the topbar while this layout is mounted */}
      <ProjectBreadcrumbSetter
        current={{
          slug: project.slug,
          name: project.name,
          thumbnailColor: project.thumbnailColor,
          thumbnailUrl: project.thumbnailUrl,
        }}
        projects={projects.map((p) => ({
          slug: p.slug,
          name: p.name,
          thumbnailColor: p.thumbnailColor,
          thumbnailUrl: p.thumbnailUrl,
        }))}
      />
      {/* Project tab bar - sits directly under the topbar (the project identity
          now lives in the topbar-left breadcrumb), so this divider lines up with
          the sidebar's org divider. Sticks under the topbar; elevation shadow
          appears only once content scrolls underneath. */}
      <StickyTabHeader>
        <ProjectTabBar slug={slug} />
      </StickyTabHeader>

      {/* Page content */}
      <main className="flex-1">{children}</main>
    </div>
    </RealtimeProvider>
  )
}
