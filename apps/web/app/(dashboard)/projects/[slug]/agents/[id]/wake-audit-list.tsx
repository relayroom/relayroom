"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useTimeAgo } from "@/lib/time-ago"
import type { WakeAuditRow } from "@/modules/wake/queries"

const PAGE = 10

/** Wake-audit rows with "show 10, load more" paging (client-side; the page passes
 *  the full window in). */
export function WakeAuditList({ rows }: { rows: WakeAuditRow[] }) {
  const t = useTranslations("wake")
  const timeAgo = useTimeAgo()
  const [visible, setVisible] = useState(PAGE)
  const shown = rows.slice(0, visible)
  const remaining = rows.length - visible

  return (
    <div className="space-y-1">
      <div className="divide-y divide-border">
        {shown.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">{row.senderName ?? row.senderPart ?? "-"}</span>
              <span className="text-muted-foreground">{t("audit.wokeBy")}</span>
              {row.agentPart && (
                <span className="font-mono text-xs bg-muted border border-border rounded px-1.5 py-0.5">{row.agentPart}</span>
              )}
              {row.projectName && (
                <span className="text-xs text-muted-foreground">{row.projectName}</span>
              )}
              {row.urgent && (
                <Badge className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  {t("audit.urgent")}
                </Badge>
              )}
              {row.suppressed && (
                <Badge variant="secondary">{t("audit.suppressedBadge")}</Badge>
              )}
            </div>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {timeAgo(row.createdAt.toISOString())}
            </span>
          </div>
        ))}
      </div>

      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + PAGE)}
          className="flex w-full items-center justify-center gap-1 rounded-md border-t border-border py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <ChevronDownIcon className="h-3.5 w-3.5" />
          {t("audit.loadMore", { count: remaining })}
        </button>
      )}
    </div>
  )
}
