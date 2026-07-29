import { getTranslations } from "next-intl/server"
import { BellOffIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { suppressionReasonKey } from "@/components/wake/suppression-reason-label"
import type { PartSuppression } from "@/modules/wake/queries"

interface Props {
  parts: PartSuppression[]
  windowHours: number
}

/**
 * Project-level view of which parts had wakes withheld, and why.
 *
 * The per-agent audit answers "why was this part quiet", which requires already
 * knowing which part to open. The incident this exists for is the opposite: parts
 * sit idle, nothing indicates which one to look at, and the reason is only
 * discoverable by reading the budget code. So the entry point is the project.
 *
 * It states what it does NOT cover, on screen. A visibility feature that implies
 * it shows everything while omitting cases is the failure this release is about,
 * and this panel genuinely omits some: coalesced wakes leave no row, and provider
 * limits are recorded only for sends. Saying so costs three lines and is the
 * difference between a screen an operator can reason from and one that quietly
 * misleads them into thinking a part was fine.
 */
export async function WakeSuppressionPanel({ parts, windowHours }: Props) {
  const t = await getTranslations("wake")

  const shown = new Set(parts.flatMap((p) => p.byReason.map((r) => r.reason)))

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <BellOffIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t("audit.suppressionsTitle")}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("audit.suppressionsSubtitle", { hours: windowHours })}
        </p>
      </div>

      {parts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("audit.suppressionsEmpty")}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {parts.map((p) => (
            <li key={p.agentId} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
              <span className="font-mono text-xs bg-muted border border-border rounded px-1.5 py-0.5">
                {p.part}
              </span>
              <span className="flex-1" />
              {p.byReason.map((r) => (
                <Badge key={String(r.reason)} variant="secondary" className="tabular-nums">
                  {t(suppressionReasonKey(r.reason))} {r.count}
                </Badge>
              ))}
            </li>
          ))}
        </ul>
      )}

      {/* Notes only for reasons actually present. A permanent list of caveats about
          reasons nobody hit reads as boilerplate and stops being read, which would
          defeat the point of having them at all. */}
      <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <p>{t("audit.suppressionsScope")}</p>
        {shown.has("budget_exhausted") && <p>{t("audit.suppressionsBudgetNote")}</p>}
        {shown.has("limited") && <p>{t("audit.suppressionsLimitedNote")}</p>}
        {shown.has("direct_cooldown") && <p>{t("audit.suppressionsCooldownNote")}</p>}
      </div>
    </div>
  )
}
