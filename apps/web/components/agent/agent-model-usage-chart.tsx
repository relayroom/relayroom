import { getTranslations } from "next-intl/server"
import type { AgentModelUsage, AgentUsageByModel } from "@/modules/agent/queries"

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${Math.round(n)}`
}
function shortDay(iso: string): string {
  const [, m, d] = iso.split("-")
  return `${Number(m)}/${Number(d)}`
}

const PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4",
  "#a855f7", "#ec4899", "#84cc16", "#f97316", "#14b8a6",
]

/**
 * Daily token usage for one agent, stacked and colored per model - since an
 * agent can switch models over time, this shows each model's share per day plus
 * per-model totals. Dependency-free, scaled to the busiest day.
 */
export async function AgentModelUsageChart({ usage }: { usage: AgentUsageByModel }) {
  const t = await getTranslations("project.agentDetail")
  const { models, days } = usage
  const colorOf = new Map(models.map((m, i) => [m.model, PALETTE[i % PALETTE.length]!]))
  const dayTotal = (d: { perModel: Record<string, number> }) =>
    Object.values(d.perModel).reduce((s, n) => s + n, 0)
  const maxDay = Math.max(1, ...days.map(dayTotal))
  const hasData = models.length > 0 && days.some((d) => dayTotal(d) > 0)

  if (!hasData) {
    return <p className="py-6 text-center text-xs text-muted-foreground">{t("noUsage")}</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex h-40 items-end gap-0.5">
        {days.map((d) => {
          const total = dayTotal(d)
          return (
            <div key={d.day} title={`${d.day} · ${compact(total)}`} className="flex h-full flex-1 flex-col-reverse">
              {models.map((m) => {
                const tok = d.perModel[m.model] ?? 0
                if (tok <= 0) return null
                return (
                  <div
                    key={m.model}
                    style={{ height: `${(tok / maxDay) * 100}%`, backgroundColor: colorOf.get(m.model) }}
                    className="w-full first:rounded-t-sm"
                  />
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{days.length > 0 ? shortDay(days[0]!.day) : ""}</span>
        <span>{days.length > 0 ? shortDay(days[days.length - 1]!.day) : ""}</span>
      </div>

      <div className="space-y-1 border-t border-border pt-3">
        {models.map((m: AgentModelUsage) => (
          <div key={m.model} className="flex items-center gap-2 text-xs">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorOf.get(m.model) }} />
            <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">{m.model}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">↑{compact(m.inputTokens)} ↓{compact(m.outputTokens)}</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">${m.costUsd.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
