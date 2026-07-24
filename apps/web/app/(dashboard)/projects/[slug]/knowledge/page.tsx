import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { BrainIcon, CheckCircle2Icon, AlertTriangleIcon, ShieldIcon, LightbulbIcon } from "lucide-react"
import { requireDashboardAccess, requireProjectAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import {
  listKnowledge,
  countKnowledgeByState,
  isKnowledgeState,
  KNOWLEDGE_STATES,
  type KnowledgeRow,
} from "@/modules/knowledge/queries"
import { getMetricWindow } from "@/modules/knowledge/metrics-queries"
import { countPendingProposals, listPlaybookVersions } from "@/modules/knowledge/proposal-queries"
import { getDateFormatters } from "@/lib/date-format.server"
import { Badge } from "@/components/ui/badge"
import { Pagination } from "@/components/ui/pagination"
import { PromoteButton } from "./promote-button"
import { LearningPanel } from "./learning-panel"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 30

const FILTER_KEYS = ["all", ...KNOWLEDGE_STATES] as const

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ state?: string; page?: string }>
}

/** Capitalized suffix for the `state<X>` / `kind<X>` message keys. */
function titleKey(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export default async function KnowledgePage({ params, searchParams }: Props) {
  const session = await requireDashboardAccess()
  const [t, { formatDateTime }] = await Promise.all([
    getTranslations("project"),
    getDateFormatters(),
  ])

  const { slug } = await params
  const sp = await searchParams

  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()
  const project = projectResult.item

  // An unrecognised ?state= falls through to "all" rather than 404ing - a stale
  // bookmark should still show the list.
  const stateFilter = sp.state && isKnowledgeState(sp.state) ? sp.state : undefined
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1)

  // Whether to OFFER the action. The action re-checks on its own - a Server
  // Action is reachable without the button, so this only decides what is drawn.
  const canPromote = (await requireProjectAccess(session.user.id, project.id, "owner")).ok

  const [result, counts, metricRows, pendingProposals, playbookVersionsForOverlay] = await Promise.all([
    listKnowledge(project.id, { state: stateFilter, page, limit: PAGE_SIZE }),
    countKnowledgeByState(project.id),
    getMetricWindow(project.id),
    // Only owners see the proposals entry and act on it; skip the count otherwise.
    canPromote ? countPendingProposals(project.id) : Promise.resolve(0),
    listPlaybookVersions(project.id),
  ])

  // Today's UTC date, computed once and passed down so the panel's honesty logic
  // stays pure (it never reads a clock itself).
  const todayUtc = new Date().toISOString().slice(0, 10)

  const entries = result.result ? result.items : []
  const totalCount = result.result ? result.totalCount : 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0)

  const hrefFor = (p: number) => {
    const q = new URLSearchParams()
    if (stateFilter) q.set("state", stateFilter)
    if (p > 1) q.set("page", String(p))
    const qs = q.toString()
    return `/projects/${slug}/knowledge${qs ? `?${qs}` : ""}`
  }

  const filterHref = (key: (typeof FILTER_KEYS)[number]) =>
    key === "all" ? `/projects/${slug}/knowledge` : `/projects/${slug}/knowledge?state=${key}`

  return (
    <div className="py-6 px-4 xs:px-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold">{t("knowledge.pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("knowledge.pageDescription")}</p>
        </div>
        {/* Owners get the entry to CI attestation. Shown only to them; the page it
            links to refuses non-owners on its own, so this is just discovery. */}
        {canPromote && (
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/projects/${slug}/knowledge/proposals`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <LightbulbIcon className="h-3.5 w-3.5" />
              {t("knowledgeProposals.badge")}
              {pendingProposals > 0 && (
                <span className="rounded-full bg-foreground px-1.5 text-[10px] font-semibold text-background tabular-nums">
                  {pendingProposals}
                </span>
              )}
            </Link>
            <Link
              href={`/projects/${slug}/knowledge/settings`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ShieldIcon className="h-3.5 w-3.5" />
              {t("tabs.knowledgeSettings")}
            </Link>
          </div>
        )}
      </div>

      {/* Learning panel: the loop's health over the project's own data, above the
          list because it frames what the list is for. Playbook versions are
          overlaid as date markers so a metric shift lines up with a change. */}
      <LearningPanel
        rows={metricRows}
        todayUtc={todayUtc}
        playbookVersions={playbookVersionsForOverlay.map((v) => ({
          version: v.version,
          day: v.createdAt.toISOString().slice(0, 10),
        }))}
      />

      {/* State filter */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {FILTER_KEYS.map((key) => {
          const active = key === "all" ? !stateFilter : key === stateFilter
          const n = key === "all" ? totalAll : counts[key]
          return (
            <Link
              key={key}
              href={filterHref(key)}
              className={[
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {t(`knowledge.filter${titleKey(key)}` as Parameters<typeof t>[0])}
              <span className="ml-1.5 text-xs tabular-nums opacity-60">{n}</span>
            </Link>
          )
        })}
      </div>

      {!result.result && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {result.message}
        </div>
      )}

      {result.result && entries.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-16 text-center space-y-3">
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-4">
              <BrainIcon className="h-8 w-8 text-muted-foreground" />
            </div>
          </div>
          <h2 className="text-base font-semibold">
            {stateFilter ? t("knowledge.emptyFilteredTitle") : t("knowledge.emptyTitle")}
          </h2>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {stateFilter
              ? t("knowledge.emptyFilteredDescription", {
                  state: t(`knowledge.state${titleKey(stateFilter)}` as Parameters<typeof t>[0]),
                })
              : t("knowledge.emptyDescription")}
          </p>
        </div>
      )}

      {result.result && entries.length > 0 && (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {entries.map((entry) => (
              <KnowledgeItem
                key={entry.id}
                entry={entry}
                projectId={project.id}
                canPromote={canPromote}
                t={t}
                formatDateTime={formatDateTime}
              />
            ))}
          </ul>

          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground tabular-nums">
              {t("knowledge.paginationInfo", {
                start: (page - 1) * PAGE_SIZE + 1,
                end: Math.min(page * PAGE_SIZE, totalCount),
                total: totalCount,
              })}
            </p>
            {totalPages > 1 && <Pagination page={page} totalPages={totalPages} hrefFor={hrefFor} />}
          </div>
        </>
      )}
    </div>
  )
}

/** Badge tone per state: trusted reads as settled, contradicted as a warning. */
function stateVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  if (state === "trusted") return "default"
  if (state === "contradicted") return "destructive"
  if (state === "retired") return "outline"
  return "secondary"
}

function KnowledgeItem({
  entry,
  projectId,
  canPromote,
  t,
  formatDateTime,
}: {
  entry: KnowledgeRow
  projectId: string
  canPromote: boolean
  t: Awaited<ReturnType<typeof getTranslations<"project">>>
  formatDateTime: (iso: string) => string
}) {
  const sourceKey = `knowledge.source${titleKey(entry.sourceKind)}` as Parameters<typeof t>[0]

  return (
    <li className="px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-xs">
          {t(`knowledge.kind${titleKey(entry.kind)}` as Parameters<typeof t>[0])}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.title}</span>
        <Badge variant={stateVariant(entry.validationState)} className="shrink-0 text-xs">
          {t(`knowledge.state${titleKey(entry.validationState)}` as Parameters<typeof t>[0])}
        </Badge>
        {/* Only a candidate can be promoted; the other three states are not
            waiting on a decision, so no button is offered for them. */}
        {canPromote && entry.validationState === "candidate" && (
          <PromoteButton projectId={projectId} knowledgeId={entry.id} />
        )}
      </div>

      <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{entry.body}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {/* The evidence count, not just the label - a state with no explanation
            behind it is what this feature exists to avoid. */}
        <span className="inline-flex items-center gap-1">
          {entry.validationState === "trusted" ? (
            <CheckCircle2Icon className="h-3 w-3" />
          ) : entry.validationState === "contradicted" ? (
            <AlertTriangleIcon className="h-3 w-3" />
          ) : null}
          {t("knowledge.supportLabel", { count: entry.supportingIssuers })}
        </span>

        <span>
          {t("knowledge.sourceLabel")} {t(sourceKey)}
        </span>

        <span className="font-mono">
          {t("knowledge.colCreated")} {formatDateTime(entry.createdAt.toISOString())}
        </span>

        {entry.promotedAt && (
          <span className="font-mono">
            {t("knowledge.colPromoted")} {formatDateTime(entry.promotedAt.toISOString())}
          </span>
        )}

        {entry.expiresAt && (
          <span className="font-mono">
            {t("knowledge.colExpires")} {formatDateTime(entry.expiresAt.toISOString())}
          </span>
        )}
      </div>
    </li>
  )
}
