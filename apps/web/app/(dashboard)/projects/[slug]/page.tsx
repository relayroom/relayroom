import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { BotIcon, MessageSquareIcon, ZapIcon, ShieldIcon, CrownIcon, InfoIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { listAgents } from "@/modules/agent/queries"
import { listThreads } from "@/modules/thread/queries"
import { listEvents } from "@/modules/event/queries"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Markdown } from "@/components/markdown"
import { getUsageSeriesForProject } from "@/modules/usage/queries"
import { UsageChart } from "@/components/dashboard/usage-chart"
import { ThreadListItem } from "@/components/thread/thread-list-item"
import { EventListItem } from "@/components/event/event-list-item"
import { PagerStatusIcon } from "@/components/agent/pager-status-icon"
import { AgentRegisterDialog } from "@/components/agent/agent-register-dialog"
import { timeAgo } from "@/lib/format"

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ slug: string }>
}

const STATUS_COLORS: Record<string, string> = {
  connected: "bg-emerald-500",
  expired: "bg-amber-500",
  revoked: "bg-red-500",
}

export default async function ProjectOverviewPage({ params }: Props) {
  const session = await requireDashboardAccess()
  const currentUserId = session.user.id
  const t = await getTranslations("project")

  const { slug } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()

  const project = projectResult.item

  const [agentsResult, threadsResult, eventsResult, usageResult] = await Promise.all([
    listAgents(project.id),
    listThreads(project.id, { page: 1, limit: 10 }),
    listEvents(project.id, { page: 1, limit: 10 }),
    getUsageSeriesForProject(project.id),
  ])

  const agentsRaw = agentsResult.result ? agentsResult.items : []
  const threads = threadsResult.result ? threadsResult.items : []
  const events = eventsResult.result ? eventsResult.items : []
  const usage = usageResult.result ? usageResult.item : null

  // Order: my agents first (main, then online, then offline), then other owners
  // by name (asc) with the same within-owner order.
  const withinRank = (a: (typeof agentsRaw)[number]) =>
    a.role === "main" ? 0 : a.activity === "offline" ? 2 : 1
  const agents = [...agentsRaw].sort((x, y) => {
    const mineX = x.ownerUserId === currentUserId ? 0 : 1
    const mineY = y.ownerUserId === currentUserId ? 0 : 1
    if (mineX !== mineY) return mineX - mineY
    if (mineX === 1) {
      const owner = (x.ownerName ?? "").localeCompare(y.ownerName ?? "")
      if (owner !== 0) return owner
    }
    const within = withinRank(x) - withinRank(y)
    if (within !== 0) return within
    return x.part.localeCompare(y.part)
  })

  // Prefer my own main agent for the highlight, else any project main.
  const mainAgent =
    agents.find((a) => a.role === "main" && a.ownerUserId === currentUserId) ??
    agents.find((a) => a.role === "main")

  return (
    <div className="py-6 px-4 xs:px-6 space-y-6 max-w-6xl mx-auto">
      {/* First-run tip: no agents yet → guide to add the main agent */}
      {agents.length === 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300/50 bg-amber-50/60 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900/50 dark:bg-amber-950/20">
          <div className="flex items-start gap-2.5">
            <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t("overview.noAgentsTipTitle")}
              </p>
              <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-200/70">
                {t("overview.noAgentsTipBody")}
              </p>
            </div>
          </div>
          <div className="shrink-0">
            <AgentRegisterDialog
              connectCode={project.connectCode ?? ""}
              projectName={project.name}
            />
          </div>
        </div>
      )}

      {/* Stats row - ordered to match the tab bar; each card links to its tab */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<MessageSquareIcon className="h-4 w-4" />}
          label={t("overview.statThreads")}
          value={threadsResult.result ? threadsResult.totalCount : "-"}
          href={`/projects/${slug}/threads`}
        />
        <StatCard
          icon={<ZapIcon className="h-4 w-4" />}
          label={t("overview.statEvents")}
          value={eventsResult.result ? eventsResult.totalCount : "-"}
          href={`/projects/${slug}/events`}
        />
        <StatCard
          icon={<BotIcon className="h-4 w-4" />}
          label={t("overview.statAgents")}
          value={project.agentCount}
          href={`/projects/${slug}/agents`}
        />
        <StatCard
          icon={<ShieldIcon className="h-4 w-4" />}
          label={t("overview.statMembers")}
          value={project.memberCount}
          href={`/projects/${slug}/members`}
        />
      </div>

      {/* Project description (markdown) - set on create/settings, surfaced here */}
      {project.description?.trim() && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("overview.aboutLabel")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Markdown content={project.description} />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Agents panel */}
        <div className="lg:col-span-1 space-y-4">
          {/* Main agent highlight */}
          {mainAgent && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span
                    className={[
                      "inline-block h-2 w-2 rounded-full",
                      STATUS_COLORS[mainAgent.status ?? ""] ?? "bg-muted",
                    ].join(" ")}
                  />
                  {t("overview.mainAgent")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 pt-0">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/projects/${slug}/agents/${mainAgent.id}`}
                    className="inline-flex min-w-0 items-center gap-1.5 font-mono text-sm font-medium hover:underline"
                  >
                    <CrownIcon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <span className="truncate">{mainAgent.nickname ?? mainAgent.part}</span>
                  </Link>
                  {mainAgent.model && (
                    <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
                      {mainAgent.model}
                    </Badge>
                  )}
                </div>
                {mainAgent.badge && (
                  <div className="text-xs text-muted-foreground">{mainAgent.badge}</div>
                )}
                {mainAgent.lastSeenAt && (
                  <div className="text-xs text-muted-foreground">
                    {t("overview.lastActivity", {
                      time: timeAgo(mainAgent.lastSeenAt.toISOString()),
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* All agents */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">
                {t("overview.connectedAgents", { count: agents.length })}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {agents.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  {t("overview.noAgents")}{" "}
                  <Link
                    href={`/projects/${slug}/agents`}
                    className="underline hover:text-foreground"
                  >
                    {t("overview.connectAgent")}
                  </Link>
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {agents.map((agent) => (
                    <li key={agent.id} className="flex items-start gap-2">
                      <span
                        className={[
                          "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0",
                          STATUS_COLORS[agent.status ?? ""] ?? "bg-muted",
                        ].join(" ")}
                      />
                      <div className="min-w-0 flex-1">
                        {/* Line 1: name (+ crown for main) */}
                        <Link
                          href={`/projects/${slug}/agents/${agent.id}`}
                          className="flex min-w-0 items-center gap-1 font-mono text-xs font-medium hover:underline"
                        >
                          {agent.role === "main" && (
                            <CrownIcon className="h-3 w-3 shrink-0 text-amber-500" />
                          )}
                          <span className="truncate">{agent.part}</span>
                        </Link>
                        {/* Line 2: owner · model (distinct, smaller) */}
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                          {agent.ownerName && <span className="truncate">{agent.ownerName}</span>}
                          {agent.ownerName && agent.model && <span aria-hidden>·</span>}
                          {agent.model && (
                            <span className="truncate font-mono">{agent.model}</span>
                          )}
                        </div>
                      </div>
                      <PagerStatusIcon agentId={agent.id} status={agent.pagerOnline} className="mt-0.5" />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Token / cost usage (last 14 days) - Details opens the usage tab */}
          {usage && <UsageChart usage={usage} className="" moreHref={`/projects/${slug}/usage`} />}
        </div>

        {/* Recent activity */}
        <div className="lg:col-span-2 space-y-4">
          {/* Recent threads */}
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">{t("overview.recentThreads")}</CardTitle>
              <Link
                href={`/projects/${slug}/threads`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("overview.viewAll")}
              </Link>
            </CardHeader>
            <CardContent className="pt-0">
              {threads.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">{t("overview.noThreads")}</p>
              ) : (
                <div className="divide-y divide-border">
                  {threads.map((thread) => (
                    <ThreadListItem
                      key={thread.id}
                      thread={thread}
                      projectSlug={slug}
                      statusLabel={t(`overview.status.${thread.status}` as never)}
                      variant="compact"
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent events */}
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">{t("overview.recentEvents")}</CardTitle>
              <Link
                href={`/projects/${slug}/events`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("overview.viewAll")}
              </Link>
            </CardHeader>
            <CardContent className="pt-0">
              {events.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">{t("overview.noEvents")}</p>
              ) : (
                <div className="divide-y divide-border">
                  {events.slice(0, 8).map((event) => (
                    <EventListItem
                      key={event.id}
                      event={event}
                      projectSlug={slug}
                      variant="compact"
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode
  label: string
  value: number | string
  href?: string
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="text-2xl font-bold tracking-tight">{value}</div>
    </>
  )
  const base = "rounded-lg border border-border bg-card p-4 space-y-1"
  if (href) {
    return (
      <Link
        href={href}
        className={`${base} block cursor-pointer transition-colors hover:border-foreground/30 hover:bg-accent/40`}
      >
        {body}
      </Link>
    )
  }
  return <div className={base}>{body}</div>
}
