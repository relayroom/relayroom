import { notFound } from "next/navigation"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { MessageSquareIcon } from "lucide-react"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import { listThreads } from "@/modules/thread/queries"
import { listAgentTargets } from "@/modules/agent/queries"
import { ThreadListItem } from "@/components/thread/thread-list-item"
import { Pagination } from "@/components/ui/pagination"
import { NewThreadButton } from "./new-thread-button"

export const dynamic = "force-dynamic"

type ThreadStatus = "open" | "answered" | "closed" | "holding" | "canceled"

const STATUS_TAB_KEYS = ["all", "open", "answered", "closed", "holding", "canceled"] as const

const PAGE_SIZE = 30

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ status?: string; q?: string; page?: string; agent?: string }>
}

export default async function ThreadsPage({ params, searchParams }: Props) {
  await requireDashboardAccess()
  const t = await getTranslations("project")

  const { slug } = await params
  const sp = await searchParams

  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()

  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()

  const project = projectResult.item

  const statusFilter =
    sp.status && sp.status !== "all" ? sp.status : undefined
  const q = sp.q
  const agentId = sp.agent
  const page = Math.max(1, parseInt(sp.page ?? "1", 10))

  const result = await listThreads(project.id, {
    status: statusFilter,
    q,
    agentId,
    page,
    limit: PAGE_SIZE,
  })

  const threads = result.result ? result.items : []
  const totalCount = result.result ? result.totalCount : 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  // Addressable parts for the "new message" composer (cheap; no usage joins).
  const agentTargets = await listAgentTargets(project.id)

  function tabHref(status: string) {
    const p = new URLSearchParams()
    if (status !== "all") p.set("status", status)
    if (q) p.set("q", q)
    if (agentId) p.set("agent", agentId)
    const s = p.toString()
    return `/projects/${slug}/threads${s ? `?${s}` : ""}`
  }

  function pageHref(p: number) {
    const params = new URLSearchParams()
    if (statusFilter) params.set("status", statusFilter)
    if (q) params.set("q", q)
    if (agentId) params.set("agent", agentId)
    if (p > 1) params.set("page", String(p))
    const s = params.toString()
    return `/projects/${slug}/threads${s ? `?${s}` : ""}`
  }

  const activeStatus = sp.status ?? "all"

  return (
    <div className="py-6 px-4 xs:px-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">{t("threads.pageTitle")}</h2>
        <div className="flex items-center gap-2">
          <NewThreadButton slug={slug} projectId={project.id} agents={agentTargets} />
          {/* Search - client side would be ideal, but server works with form submit */}
          <form method="GET" action={`/projects/${slug}/threads`} className="flex gap-2">
          {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
          {agentId && <input type="hidden" name="agent" value={agentId} />}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={t("threads.searchPlaceholder")}
            className="h-8 w-56 rounded-md border border-border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
          </form>
        </div>
      </div>

      {agentId && (
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">{t("events.filteredByAgent", { agent: agentId.slice(0, 8) })}</span>
          <Link href={`/projects/${slug}/threads`} className="text-muted-foreground hover:text-foreground">{t("events.clearFilter")}</Link>
        </div>
      )}

      {/* Status filter tabs */}
      <div className="flex gap-1 border-b border-border">
        {STATUS_TAB_KEYS.map((key) => {
          const active =
            key === activeStatus ||
            (key === "all" && !activeStatus)
          return (
            <Link
              key={key}
              href={tabHref(key)}
              className={[
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {t(`threads.status.${key}`)}
            </Link>
          )
        })}
      </div>

      {/* Error */}
      {!result.result && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {result.message}
        </div>
      )}

      {/* Empty */}
      {result.result && threads.length === 0 && (
        <div className="py-16 text-center space-y-2">
          <MessageSquareIcon className="h-8 w-8 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {q ? t("threads.noThreadsQuery", { query: q }) : t("threads.noThreads")}
          </p>
        </div>
      )}

      {/* List - status badge leads, then title / preview / author (up to 3 lines) */}
      {result.result && threads.length > 0 && (
        <>
          <div className="divide-y divide-border rounded-lg border border-border">
            {threads.map((thread) => (
              <ThreadListItem
                key={thread.id}
                thread={thread}
                projectSlug={slug}
                statusLabel={t(`threads.status.${thread.status}` as never)}
              />
            ))}
          </div>

          {/* Pagination - centered at the bottom of the list */}
          <Pagination
            page={page}
            totalPages={totalPages}
            hrefFor={pageHref}
            className="pt-2"
          />
        </>
      )}
    </div>
  )
}
