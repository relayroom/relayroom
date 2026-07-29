import { getTranslations } from "next-intl/server"
import { HistoryIcon } from "lucide-react"
import type { WakeAuditRow, WakeAuditSummary } from "@/modules/wake/queries"
import { WakeAuditList } from "./wake-audit-list"

interface Props {
  rows: WakeAuditRow[]
  summary: WakeAuditSummary
  /** This user's own sends that were blocked - a different subject, see below. */
  blockedSends: WakeAuditRow[]
  blockedSendsSummary: WakeAuditSummary
}

/**
 * Read-only audit display (spec §10.6, §11). Pure presentation: the page fetches
 * the data and passes it in. A suppressed row is not a charged consume, so it gets
 * a distinct muted badge.
 *
 * Two sections, not one list. Both come from the same table under the same
 * `ownerUserId`, but a blocked send is something this user did, not something that
 * happened to their part - shown together, the second reads as the first. They
 * previously were shown together, which is why a loop-breaker row turned up in the
 * part list with no part on it.
 */
export async function WakeAuditPanel({ rows, summary, blockedSends, blockedSendsSummary }: Props) {
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

      {/* Only rendered when there is something to say. An always-present section
          reading "0 blocked sends" would imply this panel tracks every way a send
          can fail, and it does not - it sees the loop breaker and nothing else. */}
      {blockedSends.length > 0 && (
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t("audit.blockedSendsTitle")}
            </p>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {blockedSendsSummary.total}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("audit.blockedSendsSubtitle")}</p>
          <WakeAuditList rows={blockedSends} axis="sender" />
        </div>
      )}
    </div>
  )
}
