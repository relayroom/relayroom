import { notFound } from "next/navigation"
import { LoadError } from "@/components/load-error"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import {
  ChevronLeftIcon,
  CircleIcon,
  MessageSquareIcon,
  ZapIcon,
  ArrowRightIcon,
  TerminalIcon,
} from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { getPublicServerBase } from "@/lib/server-base"
import { AgentConnectGuideDialog } from "@/components/agent/agent-connect-guide-dialog"
import { getAgent, getAgentUsageByModel, getAgentSnapshot, getMyMainAgent } from "@/modules/agent/queries"
import { listThreads } from "@/modules/thread/queries"
import { listEvents } from "@/modules/event/queries"
import { eventTitle } from "@/lib/format"
import { getTimeAgo } from "@/lib/time-ago"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { MainAgentBadge } from "@/components/agent/main-agent-badge"
import { PagerStatusBadge } from "@/components/agent/pager-status-icon"
import { LimitedBadge } from "@/components/agent/limited-badge"
import { AgentAvatar } from "@/components/agent/agent-appearance"
import { AgentModelUsageChart } from "@/components/agent/agent-model-usage-chart"
import { getOwnerWakeBudget, listOwnerWakeAudit } from "@/modules/wake/queries"
import { AgentEditForm } from "./agent-edit-form"
import { AgentMainToggle } from "./agent-main-toggle"
import { AgentConnectionDisconnectButton } from "./agent-disconnect-button"
import { AgentDeleteButton } from "./agent-delete-button"
import { OwnerWakeBudgetCard } from "./owner-wake-budget-card"
import { WakeAuditPanel } from "./wake-audit-panel"

export const dynamic = "force-dynamic"

const STATUS_COLORS: Record<string, string> = {
  connected: "text-emerald-500",
  expired: "text-amber-500",
  revoked: "text-red-500",
}

const EVENT_TYPE_STYLES: Record<string, string> = {
  spawn: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300",
  progress: "bg-muted text-muted-foreground border-border",
  complete: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300",
  error: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300",
  message: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300",
}

const THREAD_STATUS_STYLES: Record<string, string> = {
  open: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300",
  answered: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground border-border",
  holding: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300",
  canceled: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300",
}

interface Props {
  params: Promise<{ slug: string; id: string }>
  searchParams: Promise<{ connect?: string }>
}

export default async function AgentDetailPage({ params, searchParams }: Props) {
  const session = await requireDashboardAccess()
  const t = await getTranslations("project")
  const timeAgo = await getTimeAgo()
  const autoConnect = (await searchParams).connect === "1"

  const connStatusLabel = (status: string) => {
    switch (status) {
      case "connected": return t("agentDetail.connectionStatus.connected")
      case "expired": return t("agentDetail.connectionStatus.expired")
      case "revoked": return t("agentDetail.connectionStatus.revoked")
      default: return status
    }
  }

  const { slug, id } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()
  const project = projectResult.item

  const result = await getAgent(project.id, id)
  if (!result.result) notFound()
  const agent = result.item

  const [threadsResult, eventsResult, modelUsage, snapshot] = await Promise.all([
    listThreads(project.id, { agentId: id, limit: 5 }),
    listEvents(project.id, { agentId: id, limit: 8 }),
    getAgentUsageByModel(id),
    getAgentSnapshot(id),
  ])

  const recentThreads = threadsResult.result ? threadsResult.items : []
  const recentEvents = eventsResult.result ? eventsResult.items : []
  const isMain = agent.role === "main"
  const us = agent.usageSummary

  // The caller's existing main in this project (if any). When set and it is NOT
  // this agent, the toggle asks for confirmation before switching mains. We use
  // nickname when present, else the part, as the human-readable label.
  const myMain = await getMyMainAgent(project.id, session.user.id)
  const serverBase = await getPublicServerBase()
  const existingMainPart =
    myMain && myMain.id !== agent.id ? (myMain.nickname || myMain.part) : null

  // The owner wake-budget widget + audit belong on the logged-in user's OWN main
  // agent (spec §11). They reflect the logged-in owner's budget, not this agent's.
  const isMyMainAgent = isMain && agent.ownerUserId === session.user.id
  const [budgetResult, auditResult] = isMyMainAgent
    ? await Promise.all([
        getOwnerWakeBudget(session.user.id),
        // Scope the audit list to THIS project (the budget ceiling stays owner-global).
        listOwnerWakeAudit(session.user.id, 24, project.id),
      ])
    : [null, null]
  const ownerBudget = budgetResult?.result ? budgetResult.item : null

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      <Link href={`/projects/${slug}/agents`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <ChevronLeftIcon className="h-3.5 w-3.5" />
        {t("agentDetail.backToList")}
      </Link>

      {/* Header card */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-4">
          <AgentAvatar color={agent.color} icon={agent.icon} seed={agent.part} size="lg" />
          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex items-center gap-2">
              <AgentEditForm agentId={agent.id} part={agent.part} nickname={agent.nickname} badge={agent.badge} />
              {isMain && <MainAgentBadge />}
            </div>
            <div className="flex items-center flex-wrap gap-2">
              <AgentMainToggle
                agentId={agent.id}
                isMain={isMain}
                nextPart={agent.nickname || agent.part}
                existingMainPart={existingMainPart}
              />
              {agent.lastSeenAt && (
                <span className="text-xs text-muted-foreground font-mono">
                  {t("agentDetail.lastActivity", { time: timeAgo(agent.lastSeenAt.toISOString()) })}
                </span>
              )}
              {agent.relayroomMdSyncedAt ? (
                <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">{t("agentDetail.relayroomMd.synced")}</span>
              ) : (
                <span className="font-mono text-xs text-muted-foreground/70">{t("agentDetail.relayroomMd.notSynced")}</span>
              )}
              {/* Pager liveness (heartbeat) - flips live via the RealtimeProvider */}
              <PagerStatusBadge
                agentId={agent.id}
                status={agent.pagerOnline}
                lastSeenAt={agent.pagerLastSeenAt ? agent.pagerLastSeenAt.toISOString() : null}
              />
              <LimitedBadge part={agent.part} limitedUntil={agent.limitedUntil ? agent.limitedUntil.toISOString() : null} />
            </div>
            {agent.models.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                <span>{t("agentDetail.model")}:</span>
                {agent.models.map((m, i) => (
                  <span key={m} className={`font-mono bg-muted border border-border rounded px-2 py-0.5 ${i === 0 ? "text-foreground" : "opacity-60"}`}>{m}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Owner wake budget + audit (my main agent only) */}
      {isMyMainAgent && ownerBudget && (
        <OwnerWakeBudgetCard
          initial={{ wakesPerHour: ownerBudget.wakesPerHour, urgentPerHour: ownerBudget.urgentPerHour }}
        />
      )}
      {isMyMainAgent && auditResult?.result && (
        <WakeAuditPanel rows={auditResult.items} summary={auditResult.summary} />
      )}

      {/* Token usage summary - big numbers */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("agentDetail.sectionUsage")}</p>
        {us.eventCount === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agentDetail.noUsage")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: t("agentDetail.usageInput"), value: us.totalInputTokens.toLocaleString() },
                { label: t("agentDetail.usageOutput"), value: us.totalOutputTokens.toLocaleString() },
                { label: t("agentDetail.usageCache"), value: us.totalCacheTokens.toLocaleString() },
                { label: t("agentDetail.usageCost"), value: `$${us.totalCostUsd.toFixed(4)}` },
              ].map((m) => (
                <div key={m.label}>
                  <p className="text-xs text-muted-foreground mb-1">{m.label}</p>
                  <p className="font-mono text-2xl font-semibold tabular-nums tracking-tight">{m.value}</p>
                </div>
              ))}
            </div>
            <div className="border-t border-border pt-4">
              <p className="text-xs text-muted-foreground mb-3">{t("agentDetail.usageTimeSeries")}</p>
              <AgentModelUsageChart usage={modelUsage} />
            </div>
          </>
        )}
      </div>

      {/* Inspect / memory */}
      {snapshot && (snapshot.memory || snapshot.repo || Object.keys(snapshot.files).length > 0) && (
        <details className="rounded-lg border border-border bg-card p-4 [&_summary]:cursor-pointer">
          <summary className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <TerminalIcon className="h-3.5 w-3.5" />
            {t("agentDetail.sectionInspect")}
          </summary>
          <div className="mt-3 space-y-3 text-sm">
            {(snapshot.repo || snapshot.branch) && (
              <div className="font-mono text-xs text-muted-foreground">
                {snapshot.repo}{snapshot.branch ? `@${snapshot.branch}` : ""}
              </div>
            )}
            {snapshot.memory && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("agentDetail.inspectMemory")}</p>
                <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap">{snapshot.memory}</pre>
              </div>
            )}
            {Object.keys(snapshot.files).length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("agentDetail.inspectFiles", { count: Object.keys(snapshot.files).length })}</p>
                <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
                  {Object.keys(snapshot.files).slice(0, 30).map((f) => <li key={f} className="truncate">{f}</li>)}
                </ul>
              </div>
            )}
            {snapshot.syncedAt && (
              <p className="text-[11px] text-muted-foreground/70">{t("agentDetail.lastActivity", { time: timeAgo(snapshot.syncedAt.toISOString()) })}</p>
            )}
          </div>
        </details>
      )}

      {/* Connections */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t("agentDetail.sectionConnections", { count: agent.connections.length })}
          </p>
          {/* No live connection → let the user re-view the setup commands */}
          {!agent.connections.some((c) => c.status === "connected") && (
            <AgentConnectGuideDialog
              connectCode={project.connectCode ?? ""}
              part={agent.part}
              projectSlug={slug}
              serverBase={serverBase}
              defaultOpen={autoConnect}
              triggerLabel={t("agentDetail.reconnect")}
            />
          )}
        </div>
        {agent.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agentDetail.noConnections")}</p>
        ) : (
          <div className="divide-y divide-border">
            {agent.connections.map((conn) => (
              <div key={conn.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <CircleIcon className={`h-2.5 w-2.5 shrink-0 fill-current ${STATUS_COLORS[conn.status] ?? "text-muted-foreground/50"}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-medium">{conn.machineLabel ?? conn.id.slice(0, 12)}</span>
                    <Badge variant="outline" className="text-xs">{connStatusLabel(conn.status)}</Badge>
                    {conn.model && <Badge variant="secondary" className="text-xs font-mono">{conn.model}</Badge>}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    {conn.repo && <span className="text-xs text-muted-foreground font-mono truncate max-w-[180px]">{conn.repo}{conn.branch ? `@${conn.branch}` : ""}</span>}
                    {conn.lastSeenAt && <span className="text-xs text-muted-foreground font-mono">{timeAgo(conn.lastSeenAt.toISOString())}</span>}
                  </div>
                </div>
                {conn.status !== "revoked" && <AgentConnectionDisconnectButton connectionId={conn.id} machineLabel={conn.machineLabel} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent threads */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquareIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("agentDetail.sectionRecentThreads")}</p>
          </div>
          {recentThreads.length > 0 && (
            <Link href={`/projects/${slug}/threads?agent=${id}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {t("agentDetail.viewMore")}<ArrowRightIcon className="h-3 w-3" />
            </Link>
          )}
        </div>
        {!threadsResult.result ? (
          <LoadError variant="inline" message={threadsResult.message} />
        ) : recentThreads.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agentDetail.noRecentThreads")}</p>
        ) : (
          <div className="divide-y divide-border">
            {recentThreads.map((thread) => (
              <Link key={thread.id} href={`/projects/${slug}/threads/${thread.id}`} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0 group">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium group-hover:underline">{thread.subject}</span>
                  <span className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${THREAD_STATUS_STYLES[thread.status] ?? "bg-muted text-muted-foreground border-border"}`}>
                    {t(`agentDetail.threadStatus.${thread.status}` as never)}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground font-mono">
                  {thread.lastMessageAt ? timeAgo(thread.lastMessageAt.toISOString()) : timeAgo(thread.createdAt.toISOString())}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Recent events */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ZapIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("agentDetail.sectionRecentEvents")}</p>
          </div>
          {recentEvents.length > 0 && (
            <Link href={`/projects/${slug}/events?agent=${id}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {t("agentDetail.viewMore")}<ArrowRightIcon className="h-3 w-3" />
            </Link>
          )}
        </div>
        {!eventsResult.result ? (
          <LoadError variant="inline" message={eventsResult.message} />
        ) : recentEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agentDetail.noRecentEvents")}</p>
        ) : (
          <div className="divide-y divide-border">
            {recentEvents.map((event) => (
              <Link key={event.id} href={`/projects/${slug}/events/${event.id}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 hover:bg-muted/30 rounded px-1 -mx-1 transition-colors">
                <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-mono font-medium shrink-0 ${EVENT_TYPE_STYLES[event.type] ?? "bg-muted text-muted-foreground border-border"}`}>
                  {event.type}
                </span>
                <span className="flex-1 truncate text-sm min-w-0">{eventTitle(event)}</span>
                <span className="text-xs text-muted-foreground font-mono shrink-0">{timeAgo(event.createdAt.toISOString())}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div className="pt-4">
        <Separator />
        <div className="mt-8 rounded-lg border border-destructive/30">
        <div className="border-b border-destructive/20 px-5 py-3">
          <h2 className="text-sm font-semibold text-destructive">{t("agentDetail.dangerZone")}</h2>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("agentDetail.deleteAgentTitle")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("agentDetail.deleteAgentDescription")}</p>
          </div>
          <AgentDeleteButton agentId={agent.id} part={agent.part} slug={slug} />
        </div>
        </div>
      </div>
    </div>
  )
}
