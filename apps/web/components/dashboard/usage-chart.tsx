import Link from "next/link"
import { TrendingUpIcon } from "lucide-react"
import { getTranslations } from "next-intl/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { UsageSeries } from "@/modules/usage/queries"

/** Compact token count: 1234 -> "1.2K", 1_500_000 -> "1.5M". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${Math.round(n)}`
}

/** "2026-06-11" -> "6/11" */
function shortDay(iso: string): string {
  const [, m, d] = iso.split("-")
  return `${Number(m)}/${Number(d)}`
}

interface Props {
  usage: UsageSeries
  /** Override the Card class (e.g. grid span). Defaults to the dashboard span. */
  className?: string
  /** When set, a "Details" link is shown in the header (e.g. the usage tab). */
  moreHref?: string
}

/**
 * Dependency-free daily usage chart (stacked input/output tokens per day).
 * Server component — purely presentational, scaled to the window's max day.
 */
export async function UsageChart({ usage, className, moreHref }: Props) {
  const t = await getTranslations("dashboard.usage")

  const maxDay = Math.max(
    1,
    ...usage.days.map((d) => d.inputTokens + d.outputTokens + d.cacheTokens),
  )
  const hasData = usage.totalTokens > 0

  return (
    <Card className={className ?? "col-span-1 md:col-span-2 xl:col-span-4"}>
      <CardHeader className="space-y-1.5 pb-3">
        {/* Row 1: title + (optional) details link */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <TrendingUpIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CardTitle className="truncate text-sm font-medium text-muted-foreground">
              {t("cardTitle")}
            </CardTitle>
          </div>
          {moreHref && (
            <Link
              href={moreHref}
              className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("more")}
            </Link>
          )}
        </div>
        {/* Row 2: totals + window label */}
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="text-sm font-semibold tabular-nums">
              {compact(usage.totalTokens)}
              <span className="ml-1 text-xs font-normal text-muted-foreground">{t("tokens")}</span>
            </span>
            <span className="text-sm font-semibold tabular-nums">
              ${usage.totalCostUsd.toFixed(2)}
            </span>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("recentDays", { days: usage.windowDays })}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {/* Bars */}
        <div className="flex h-24 items-end gap-1">
          {usage.days.map((d) => {
            const total = d.inputTokens + d.outputTokens + d.cacheTokens
            const pct = (total / maxDay) * 100
            const outShare = total > 0 ? (d.outputTokens / total) * 100 : 0
            const title = `${d.day} · ${t("inputLabel").toLowerCase()} ${compact(d.inputTokens)} · ${t("outputLabel").toLowerCase()} ${compact(d.outputTokens)}${d.costUsd > 0 ? ` · $${d.costUsd.toFixed(4)}` : ""}`
            return (
              <div
                key={d.day}
                title={title}
                className="flex flex-1 flex-col justify-end"
                style={{ height: "100%" }}
              >
                {hasData ? (
                  <div
                    className="flex w-full flex-col overflow-hidden"
                    style={{ height: `${Math.max(pct, total > 0 ? 4 : 0)}%` }}
                  >
                    {/* output (strong) on top, input (faint) below */}
                    <div
                      className="w-full bg-foreground"
                      style={{ height: `${outShare}%` }}
                    />
                    <div className="w-full flex-1 bg-foreground/25" />
                  </div>
                ) : (
                  <div className="w-full bg-muted opacity-40" style={{ height: "30%" }} />
                )}
              </div>
            )
          })}
        </div>

        {/* X-axis: first / last labels */}
        <div className="mt-2 flex justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>{usage.days.length > 0 ? shortDay(usage.days[0]!.day) : ""}</span>
          <span>
            {usage.days.length > 0 ? shortDay(usage.days[usage.days.length - 1]!.day) : ""}
          </span>
        </div>

        {hasData ? (
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm bg-foreground" /> {t("outputLabel")}{" "}
              {compact(usage.totalOutputTokens)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm bg-foreground/25" /> {t("inputLabel")}{" "}
              {compact(usage.totalInputTokens)}
            </span>
            {usage.totalCacheTokens > 0 && (
              <span>{t("cacheLabel")} {compact(usage.totalCacheTokens)}</span>
            )}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("noData")}
          </p>
        )}

        {/* Per-model breakdown */}
        {usage.byModel.length > 0 && (
          <div className="mt-4 border-t border-border pt-3 space-y-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("byModel")}
            </p>
            <div className="space-y-1">
              {usage.byModel.map((m) => (
                <div key={m.model} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-xs text-foreground/80 min-w-0 truncate flex-1">
                    {m.model}
                  </span>
                  <span className="tabular-nums text-muted-foreground shrink-0">
                    {compact(m.totalTokens)}
                  </span>
                  <span className="tabular-nums text-muted-foreground shrink-0 w-16 text-right">
                    ${m.costUsd.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
