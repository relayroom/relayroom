import { getTranslations } from "next-intl/server"
import { HistoryIcon } from "lucide-react"
import type { WakeAuditRow, WakeAuditSummary } from "@/modules/wake/queries"
import { WakeAuditList } from "./wake-audit-list"

interface Props {
  rows: WakeAuditRow[]
  summary: WakeAuditSummary
}

/**
 * Read-only audit display (spec §10.6, §11). Pure presentation: the page fetches
 * the data and passes it in. "suppressed" rows are budget-exhausted suppressions,
 * NOT charged consumes, so they get a distinct muted badge.
 */
export async function WakeAuditPanel({ rows, summary }: Props) {
  const t = await getTranslations("wake")

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HistoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t("audit.title")}
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
          <span>{t("audit.total")} {summary.total}</span>
          <span className="text-amber-600 dark:text-amber-400">{t("audit.urgent")} {summary.urgentCount}</span>
          <span>{t("audit.suppressed")} {summary.suppressedCount}</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("audit.subtitle", { hours: summary.windowHours })}
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("audit.empty")}</p>
      ) : (
        <WakeAuditList rows={rows} />
      )}
    </div>
  )
}
