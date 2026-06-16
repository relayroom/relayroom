import type { ReactNode } from "react"
import { notFound } from "next/navigation"
import { requireDashboardAccess } from "@/lib/auth-session"
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
  await requireDashboardAccess()

  const { slug } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const result = await getProjectBySlug(orgId, slug)
  if (!result.result) notFound()

  const project = result.item

  // Sibling projects for the topbar breadcrumb switcher.
  const listResult = await listProjects(orgId)
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
