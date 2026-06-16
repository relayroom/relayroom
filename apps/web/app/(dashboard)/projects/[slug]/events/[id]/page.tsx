import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { ChevronLeftIcon, ChevronRightIcon, ZapIcon, BotIcon, ClockIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { getEvent } from "@/modules/event/queries"
import { formatDateTime, eventTitle } from "@/lib/format"
import { MainAgentBadge } from "@/components/agent/main-agent-badge"

export const dynamic = "force-dynamic"

const EVENT_TYPE_STYLES: Record<string, string> = {
  spawn: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300",
  progress: "bg-muted text-muted-foreground border-border",
  complete: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300",
  error: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300",
  message: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300",
}

function formatDurationMs(startedAt: Date | null, endedAt: Date | null): string | null {
  if (!startedAt || !endedAt) return null
  const ms = endedAt.getTime() - startedAt.getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}

interface Props {
  params: Promise<{ slug: string; id: string }>
}

export default async function EventDetailPage({ params }: Props) {
  await requireDashboardAccess()
  const t = await getTranslations("project")

  const { slug, id } = await params
  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()
  const project = projectResult.item

  const result = await getEvent(project.id, id)
  if (!result.result) notFound()
  const event = result.item

  const typeStyle = EVENT_TYPE_STYLES[event.type] ?? "bg-muted text-muted-foreground border-border"
  const duration = formatDurationMs(event.startedAt, event.endedAt)
  const u = event.usage
  const progressFields: { label: string; value: string }[] = [
    { label: t("eventDetail.timingStart"), value: event.startedAt ? formatDateTime(event.startedAt.toISOString()) : "-" },
    { label: t("eventDetail.timingEnd"), value: event.endedAt ? formatDateTime(event.endedAt.toISOString()) : "-" },
    ...(duration ? [{ label: t("eventDetail.timingDuration"), value: duration }] : []),
    ...(u?.input_tokens !== undefined ? [{ label: t("eventDetail.usageInput"), value: u.input_tokens.toLocaleString() }] : []),
    ...(u?.output_tokens !== undefined ? [{ label: t("eventDetail.usageOutput"), value: u.output_tokens.toLocaleString() }] : []),
    ...(u?.cache_tokens !== undefined ? [{ label: t("eventDetail.usageCache"), value: u.cache_tokens.toLocaleString() }] : []),
    ...(u?.cost_usd !== undefined ? [{ label: t("eventDetail.usageCost"), value: `$${u.cost_usd.toFixed(6)}` }] : []),
  ]

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      <Link href={`/projects/${slug}/events`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <ChevronLeftIcon className="h-3.5 w-3.5" />
        {t("eventDetail.backToList")}
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="rounded-full bg-muted p-2.5 shrink-0">
            <ZapIcon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-mono font-semibold ${typeStyle}`}>{event.type}</span>
              {event.spawnedAgentLabel && <span className="text-xs text-muted-foreground font-mono">→ {event.spawnedAgentLabel}</span>}
            </div>
            <p className="mt-1 truncate text-sm font-medium">{eventTitle(event)}</p>
            <p className="text-xs text-muted-foreground font-mono">{formatDateTime(event.createdAt.toISOString())}</p>
          </div>
        </div>
        <p className="shrink-0 font-mono text-xs text-muted-foreground">{event.id.slice(0, 16)}</p>
      </div>

      {/* Lineage */}
      {(event.lineage.length > 0 || event.spawnedCount > 0) && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("eventDetail.sectionLineage")}</p>
          {event.lineage.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {event.lineage.map((a, i) => (
                <div key={a.id} className="flex items-center gap-1">
                  {i > 0 && <ChevronRightIcon className="h-3 w-3 text-muted-foreground/50 shrink-0" />}
                  <Link href={`/projects/${slug}/events/${a.id}`} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-mono transition-colors hover:border-foreground/40 ${EVENT_TYPE_STYLES[a.type] ?? "bg-muted text-muted-foreground border-border"}`}>
                    {a.type}{a.agentPart && <span className="opacity-60">/{a.agentPart}</span>}
                  </Link>
                </div>
              ))}
              <ChevronRightIcon className="h-3 w-3 text-muted-foreground/50 shrink-0" />
              <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-mono font-semibold ring-1 ring-foreground/20 ${typeStyle}`}>{t("eventDetail.currentEvent")}</span>
            </div>
          )}
          {event.spawnedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {t.rich("eventDetail.spawnedCount", { count: () => <span className="font-mono font-medium">{event.spawnedCount}</span> })}
            </p>
          )}
        </div>
      )}

      {/* Emitting agent: owner + model + main badge */}
      {event.agentId && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">{t("eventDetail.sectionAgent")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/projects/${slug}/agents/${event.agentId}`} className="flex items-center gap-2 group">
              <div className="rounded-full bg-violet-100 dark:bg-violet-950 p-1.5">
                <BotIcon className="h-3.5 w-3.5 text-violet-700 dark:text-violet-300" />
              </div>
              <span className="font-mono text-sm font-medium group-hover:underline">{event.agentPart ?? event.agentId.slice(0, 12)}</span>
            </Link>
            {event.agentRole === "main" && <MainAgentBadge />}
            {event.agentNickname && <span className="text-xs text-muted-foreground">"{event.agentNickname}"</span>}
            {event.agentOwnerName && <span className="text-xs text-muted-foreground">· {event.agentOwnerName}</span>}
            {u?.model && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{u.model}</span>}
          </div>
        </div>
      )}

      {/* Event progress: timing + tokens + cost merged */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ClockIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("eventDetail.sectionProgress")}</p>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {progressFields.map((f) => (
            <div key={f.label}>
              <p className="text-xs text-muted-foreground mb-0.5">{f.label}</p>
              <p className="font-mono text-sm font-medium tabular-nums">{f.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Detail JSON */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("eventDetail.sectionDetail")}</p>
        <pre className="overflow-auto rounded-md bg-muted/50 px-4 py-3 text-xs font-mono text-foreground/80 max-h-96">
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      </div>
    </div>
  )
}
