import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { ZapIcon, XIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { listEvents } from "@/modules/event/queries"
import { EventListItem } from "@/components/event/event-list-item"
import { getTimeAgo } from "@/lib/time-ago"
import { Pagination } from "@/components/ui/pagination"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 50

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string; page?: string; agent?: string }>
}

export default async function EventsPage({ params, searchParams }: Props) {
  await requireDashboardAccess()
  const t = await getTranslations("project")
  const timeAgo = await getTimeAgo()

  const { slug } = await params
  const sp = await searchParams

  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()

  const project = projectResult.item
  const q = sp.q
  const agentId = sp.agent
  const page = Math.max(1, parseInt(sp.page ?? "1", 10))

  const result = await listEvents(project.id, { q, agentId, page, limit: PAGE_SIZE })

  const events = result.result ? result.items : []
  const totalCount = result.result ? result.totalCount : 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const agentLabel = events.find((e) => e.agentId === agentId)?.agentPart ?? null

  function hrefWith(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams()
    const merged = { q, agent: agentId, page: page > 1 ? String(page) : undefined, ...overrides }
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v)
    const s = p.toString()
    return `/projects/${slug}/events${s ? `?${s}` : ""}`
  }

  return (
    <div className="py-6 px-4 xs:px-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t("events.pageTitle")}</h2>
          {result.result && (
            <p className="text-xs text-muted-foreground">{t("events.totalCount", { total: totalCount })}</p>
          )}
        </div>
        <form method="GET" action={`/projects/${slug}/events`} className="flex gap-2">
          {agentId && <input type="hidden" name="agent" value={agentId} />}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={t("events.searchPlaceholder")}
            className="h-8 w-56 rounded-md border border-border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
        </form>
      </div>

      {/* Agent filter banner */}
      {agentId && (
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            {t("events.filteredByAgent", { agent: agentLabel ?? agentId.slice(0, 8) })}
          </span>
          <Link href={hrefWith({ agent: undefined, page: undefined })} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <XIcon className="h-3 w-3" />
            {t("events.clearFilter")}
          </Link>
        </div>
      )}

      {!result.result && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {result.message}
        </div>
      )}

      {result.result && events.length === 0 ? (
        <div className="py-16 text-center space-y-2">
          <ZapIcon className="h-8 w-8 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {q ? t("events.noEventsQuery", { query: q }) : t("events.noEvents")}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {events.map((event) => (
            <EventListItem
              key={event.id}
              event={event}
              projectSlug={slug}
              timeLabel={timeAgo(event.createdAt.toISOString())}
            />
          ))}
        </div>
      )}

      {/* Pagination - centered at the bottom of the list */}
      <Pagination
        page={page}
        totalPages={totalPages}
        hrefFor={(p) => hrefWith({ page: p > 1 ? String(p) : undefined })}
        className="pt-2"
      />
    </div>
  )
}
