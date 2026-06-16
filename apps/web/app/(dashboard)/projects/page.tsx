import Link from "next/link"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { PlusIcon, FolderOpenIcon, UsersIcon, BotIcon, MessageSquareIcon, ActivityIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { listProjects } from "@/modules/project/queries"
import { timeAgo } from "@/lib/format"
import { readableOn, projectInitials, DEFAULT_PROJECT_COLOR } from "@/lib/project-colors"
import { Sparkline } from "@/components/dashboard/sparkline"
import { Button } from "@/components/ui/button"

export const dynamic = "force-dynamic"

export default async function ProjectsPage() {
  await requireDashboardAccess()
  const t = await getTranslations("project")

  const orgId = await resolveActiveOrgId()
  if (!orgId) {
    // User has no org - redirect to organizations to create or join one
    redirect("/organizations")
  }

  const result = await listProjects(orgId)

  const projects = result.result ? result.items : []

  return (
    <div className="py-6 px-4 xs:px-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("list.pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("list.pageDescription")}
          </p>
        </div>
        <Button render={<Link href="/projects/new" />} size="sm">
          <PlusIcon className="h-4 w-4 mr-1.5" />
          {t("list.newProject")}
        </Button>
      </div>

      {/* Error state */}
      {!result.result && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {result.message}
        </div>
      )}

      {/* Empty state */}
      {result.result && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-16 text-center space-y-4">
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-4">
              <FolderOpenIcon className="h-8 w-8 text-muted-foreground" />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-base font-semibold">{t("list.emptyTitle")}</h2>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {t("list.emptyDescription")}
            </p>
          </div>
          <Button render={<Link href="/projects/new" />} size="sm">
            <PlusIcon className="h-4 w-4 mr-1.5" />
            {t("list.createFirst")}
          </Button>
        </div>
      )}

      {/* Project grid */}
      {result.result && projects.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => {
            const color = project.thumbnailColor || DEFAULT_PROJECT_COLOR
            return (
              <Link
                key={project.id}
                href={`/projects/${project.slug}`}
                className="group flex flex-col rounded-lg border border-border bg-card p-5 transition-all hover:border-foreground/20 hover:shadow-sm"
              >
                {/* Header: project icon + name + summary */}
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-mono text-sm font-bold"
                    style={{ backgroundColor: color, color: readableOn(color) }}
                  >
                    {projectInitials(project.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold leading-snug">{project.name}</h2>
                    {project.summary && (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {project.summary}
                      </p>
                    )}
                  </div>
                  {/* Token-usage activity sparkline (last 14 days) */}
                  <Sparkline
                    data={project.usageSparkline}
                    className="w-16 shrink-0"
                    title={`${project.usageSparkline.reduce((a, b) => a + b, 0).toLocaleString()} tokens · 14d`}
                  />
                </div>

                {/* Stats */}
                <div className="mt-4 grid grid-cols-3 divide-x divide-border rounded-md border border-border bg-muted/30">
                  <Stat icon={<BotIcon className="h-3.5 w-3.5" />} value={project.agentCount} label={t("list.statAgents")} />
                  <Stat icon={<MessageSquareIcon className="h-3.5 w-3.5" />} value={project.threadCount} label={t("list.statThreads")} />
                  <Stat icon={<UsersIcon className="h-3.5 w-3.5" />} value={project.memberCount} label={t("list.statMembers")} />
                </div>

                {/* Footer: last activity */}
                <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ActivityIcon className="h-3 w-3 shrink-0" />
                  {project.lastActivityAt ? (
                    <span className="font-mono">{timeAgo(project.lastActivityAt.toISOString())}</span>
                  ) : (
                    <span>{t("list.noActivity")}</span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode
  value: number
  label: string
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-2.5">
      <span className="flex items-center gap-1 text-sm font-semibold tabular-nums">
        <span className="text-muted-foreground">{icon}</span>
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  )
}
