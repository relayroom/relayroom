import { getTranslations } from "next-intl/server"
import { CrownIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { resolveAgentColor, type AgentColor } from "@/components/agent/agent-appearance"
import { cn } from "@/lib/utils"
import type { UsageDayAgents, UsageAgentTotal } from "@/modules/usage/queries"

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${Math.round(n)}`
}

function shortDay(iso: string): string {
  const [, m, d] = iso.split("-")
  return `${Number(m)}/${Number(d)}`
}

interface Props {
  dayAgents: UsageDayAgents[]
  agents: UsageAgentTotal[]
  /** Each agent's configured color key (agents.color), keyed by part. Falls back
   * to a deterministic hue per part when unset. */
  colorByPart?: Record<string, string | null>
  /** Parts that are a project main agent (crown in the legend). */
  mainParts?: string[]
  className?: string
}

/**
 * Daily token usage stacked by agent - one bar per day, segmented and colored
 * per agent part, so you can see each agent's contribution overlaid over time.
 * Dependency-free; scaled to the busiest day in the range.
 */
export async function AgentUsageChart({ dayAgents, agents, colorByPart, mainParts, className }: Props) {
  const t = await getTranslations("project.usageDetail")
  const mainSet = new Set(mainParts ?? [])

  // Use each agent's configured color (consistent with its avatar elsewhere). A
  // hairline separator between segments keeps same-colored agents distinguishable.
  const colorOf = new Map<string, AgentColor>(
    agents.map((a) => [a.part, resolveAgentColor(colorByPart?.[a.part], a.part)]),
  )
  const dayTotal = (d: UsageDayAgents) => Object.values(d.perAgent).reduce((s, n) => s + n, 0)
  const maxDay = Math.max(1, ...dayAgents.map(dayTotal))
  const hasData = agents.length > 0 && dayAgents.some((d) => dayTotal(d) > 0)

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {t("byAgentTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <>
            <div className="flex h-40 items-end gap-1">
              {dayAgents.map((d) => {
                const total = dayTotal(d)
                const title = `${d.day} · ${compact(total)}`
                return (
                  <div
                    key={d.day}
                    title={title}
                    className="flex h-full flex-1 flex-col-reverse"
                  >
                    {agents.map((a) => {
                      const tok = d.perAgent[a.part] ?? 0
                      if (tok <= 0) return null
                      return (
                        <div
                          key={a.part}
                          style={{ height: `${(tok / maxDay) * 100}%` }}
                          className={cn("w-full border-b border-card", colorOf.get(a.part)?.swatch)}
                        />
                      )
                    })}
                  </div>
                )
              })}
            </div>

            {/* X-axis: first / last day */}
            <div className="mt-2 flex justify-between text-[10px] tabular-nums text-muted-foreground">
              <span>{dayAgents.length > 0 ? shortDay(dayAgents[0]!.day) : ""}</span>
              <span>{dayAgents.length > 0 ? shortDay(dayAgents[dayAgents.length - 1]!.day) : ""}</span>
            </div>

            {/* Legend + per-agent totals */}
            <div className="mt-4 space-y-1 border-t border-border pt-3">
              {agents.map((a) => (
                <div key={a.part} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-sm", colorOf.get(a.part)?.swatch)}
                  />
                  <span className="flex min-w-0 flex-1 items-center gap-1 truncate font-mono text-foreground/80">
                    {mainSet.has(a.part) && <CrownIcon className="h-3 w-3 shrink-0 text-amber-500" />}
                    {a.part}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{compact(a.totalTokens)}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                    ${a.costUsd.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("byAgentEmpty")}</p>
        )}
      </CardContent>
    </Card>
  )
}
