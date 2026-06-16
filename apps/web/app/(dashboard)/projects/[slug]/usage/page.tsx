import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { requireDashboardAccess } from "@/lib/auth-session"
import { resolveActiveOrgId } from "@/lib/active-org"
import { getProjectBySlug } from "@/modules/project/queries"
import {
  getProjectUsageDetail,
  type UsageSeries,
} from "@/modules/usage/queries"
import { listAgents } from "@/modules/agent/queries"
import { UsageChart } from "@/components/dashboard/usage-chart"
import { AgentUsageChart } from "@/components/dashboard/agent-usage-chart"
import { UsageRangeControls } from "./usage-range-controls"

export const dynamic = "force-dynamic"

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}

export default async function ProjectUsagePage({ params, searchParams }: Props) {
  await requireDashboardAccess()
  const { slug } = await params
  const { from: fromParam, to: toParam } = await searchParams

  const orgId = await resolveActiveOrgId()
  if (!orgId) notFound()
  const projectResult = await getProjectBySlug(orgId, slug)
  if (!projectResult.result) notFound()
  const project = projectResult.item

  const today = new Date().toISOString().slice(0, 10)
  const to = toParam && ISO_DAY.test(toParam) ? toParam : today
  const from = fromParam && ISO_DAY.test(fromParam) ? fromParam : isoDaysAgo(29)

  const t = await getTranslations("project.usageDetail")
  const [result, agentsRes] = await Promise.all([
    getProjectUsageDetail(project.id, from, to),
    listAgents(project.id),
  ])

  // Map each agent's configured color (by part) so the chart matches its avatar,
  // and the parts that are a project main agent (for the legend crown).
  const colorByPart: Record<string, string | null> = {}
  const mainParts: string[] = []
  if (agentsRes.result) {
    for (const a of agentsRes.items) {
      colorByPart[a.part] = a.color ?? null
      if (a.role === "main") mainParts.push(a.part)
    }
  }

  if (!result.result) {
    return (
      <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {result.message}
        </div>
      </div>
    )
  }

  const detail = result.item
  const series: UsageSeries = {
    days: detail.days,
    totalInputTokens: detail.totalInputTokens,
    totalOutputTokens: detail.totalOutputTokens,
    totalCacheTokens: detail.totalCacheTokens,
    totalTokens: detail.totalTokens,
    totalCostUsd: detail.totalCostUsd,
    windowDays: detail.days.length,
    byModel: detail.byModel,
  }

  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">{t("title")}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <UsageRangeControls from={from} to={to} firstDay={detail.firstDay} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <UsageChart usage={series} className="" />
        <AgentUsageChart
          dayAgents={detail.dayAgents}
          agents={detail.agents}
          colorByPart={colorByPart}
          mainParts={mainParts}
          className=""
        />
      </div>
    </div>
  )
}
