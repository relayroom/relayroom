import Link from "next/link"
import {
  BotIcon,
  BuildingIcon,
  PlusIcon,
  ArrowRightIcon,
} from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getDashboardSummary } from "@/modules/dashboard/queries"
import { getUsageSeries } from "@/modules/usage/queries"
import { getTelemetryStatus } from "@/modules/telemetry/actions"
import { getTranslations } from "next-intl/server"
import { Button } from "@/components/ui/button"
import { TelemetryConsentBanner } from "@/components/telemetry/consent-banner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { UsageChart } from "@/components/dashboard/usage-chart"
import { timeAgo } from "@/lib/format"

export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  const session = await requireDashboardAccess()

  const orgId = await resolveActiveOrgId()

  const summary = orgId
    ? await getDashboardSummary(orgId, session.user.id)
    : null

  const data = summary?.result ? summary.item : null

  const usageResult = orgId ? await getUsageSeries(orgId) : null
  const usage = usageResult?.result ? usageResult.item : null
  const userName = session.user.name ?? session.user.email

  const t = await getTranslations("dashboard")

  // Telemetry consent banner: shown only to the instance superuser, and only
  // until a choice has been made. getTelemetryStatus denies non-superusers, so a
  // failed result simply hides the banner.
  const telemetry = await getTelemetryStatus()
  const showTelemetryBanner = telemetry.result && !telemetry.item.chosen

  return (
    <div className="py-6 px-4 xs:px-6 space-y-8 max-w-6xl mx-auto">
      {showTelemetryBanner && <TelemetryConsentBanner />}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("greeting", { name: userName })}
        </p>
      </div>

      {/* No org state */}
      {!orgId && (
        <div className="rounded-lg border border-dashed border-border p-16 text-center space-y-4">
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-4">
              <BuildingIcon className="h-8 w-8 text-muted-foreground" />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-base font-semibold">{t("noOrg.title")}</h2>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {t("noOrg.description")}
            </p>
          </div>
          <Button render={<Link href="/organizations/new" />} size="sm">
            <PlusIcon className="h-4 w-4 mr-1.5" />
            {t("noOrg.createButton")}
          </Button>
        </div>
      )}

      {/* Widget grid */}
      {orgId && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* Projects widget */}
          <Card className="col-span-1 md:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <div>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("projects.widgetTitle")}
                </CardTitle>
                <p className="text-2xl font-bold mt-1">{data?.projectCount ?? 0}</p>
              </div>
              <Link
                href="/projects"
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="hidden sm:inline">{t("projects.viewAllShort")}</span>
                <ArrowRightIcon className="h-4 w-4" />
              </Link>
            </CardHeader>
            <CardContent>
              {/* Empty state */}
              {data?.projectCount === 0 && (
                <div className="rounded-md border border-dashed border-border p-6 text-center space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t("projects.emptyDescription")}
                  </p>
                  <Button render={<Link href="/projects/new" />} size="sm" variant="ghost">
                    <PlusIcon className="h-3.5 w-3.5 mr-1" />
                    {t("projects.emptyButton")}
                  </Button>
                </div>
              )}

              {/* Recent projects */}
              {(data?.recentProjects?.length ?? 0) > 0 && (
                <ul className="space-y-1">
                  {data!.recentProjects.map((project) => (
                    <li key={project.id}>
                      <Link
                        href={`/projects/${project.slug}`}
                        className="flex items-center gap-3 rounded-sm px-2 py-2 hover:bg-accent transition-colors group"
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: project.thumbnailColor ?? "hsl(var(--muted-foreground))",
                          }}
                        />
                        <span className="flex-1 text-sm font-medium truncate group-hover:text-accent-foreground">
                          {project.name}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                          <BotIcon className="h-3 w-3" />
                          {project.agentCount}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono shrink-0">
                          {timeAgo(project.createdAt.toISOString())}
                        </span>
                      </Link>
                    </li>
                  ))}
                  {(data?.projectCount ?? 0) > 4 && (
                    <li>
                      <Link
                        href="/projects"
                        className="block text-center text-xs text-muted-foreground hover:text-foreground py-1 transition-colors"
                      >
                        {t("projects.viewAll", { count: data!.projectCount })}
                      </Link>
                    </li>
                  )}
                </ul>
              )}

              {!data && (
                <div className="space-y-2">
                  {[...Array(3)].map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Agent summary widget */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <BotIcon className="h-4 w-4" />
                  {t("agents.widgetTitle")}
                </CardTitle>
                <Link
                  href="/agents"
                  className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowRightIcon className="h-4 w-4" />
                </Link>
              </div>
              <p className="text-2xl font-bold">{data?.agentSummary.total ?? 0}</p>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("agents.active")}</span>
                <span className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {data?.agentSummary.connected ?? 0}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("agents.offline")}</span>
                <span className="text-muted-foreground font-mono">
                  {data?.agentSummary.offline ?? 0}
                </span>
              </div>
              {data?.agentSummary.total === 0 && (
                <p className="text-xs text-muted-foreground pt-1">
                  {t("agents.emptyHint")}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Orgs widget */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <BuildingIcon className="h-4 w-4" />
                  {t("orgs.widgetTitle")}
                </CardTitle>
                <Link
                  href="/organizations"
                  className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowRightIcon className="h-4 w-4" />
                </Link>
              </div>
              <p className="text-2xl font-bold">{data?.orgCount ?? 0}</p>
            </CardHeader>
            <CardContent>
              {(data?.orgs?.length ?? 0) > 0 ? (
                <ul className="space-y-1.5">
                  {data!.orgs.slice(0, 3).map((org) => (
                    <li key={org.id}>
                      <Link
                        href={`/organizations/${org.slug ?? org.id}`}
                        className="flex items-center gap-2 text-sm hover:text-foreground transition-colors"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-foreground text-background text-[10px] font-bold uppercase">
                          {org.name.charAt(0)}
                        </span>
                        <span className="flex-1 truncate text-muted-foreground">{org.name}</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                          {org.role}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <Link
                  href="/organizations/new"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t("orgs.createLink")}
                </Link>
              )}
            </CardContent>
          </Card>

          {/* Token / cost usage (last 14 days) */}
          {usage && <UsageChart usage={usage} />}
        </div>
      )}
    </div>
  )
}
