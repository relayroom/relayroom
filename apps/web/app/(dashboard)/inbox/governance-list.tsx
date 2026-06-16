"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export interface GovernanceAlertItem {
  id: string
  projectSlug: string
  projectName: string
  subjectUserId: string | null
  subjectName: string | null
  subjectEmail: string | null
  kind: string
  detail: Record<string, unknown>
}

const KNOWN_KINDS = ["loop_breaker", "phantom_turns", "broadcast_spike", "budget_drain"] as const

/**
 * Governance alerts lane (managers only). Each row names the flagged member and
 * the pattern, links to the audit view (phase 10) for context, and offers a
 * Review action that will become the ban dialog once phase 09 lands. This phase
 * is detection + alerting only; the Review button is a link, not a ban call.
 */
export function GovernanceList({ alerts }: { alerts: GovernanceAlertItem[] }) {
  const t = useTranslations("governance")

  return (
    <ul className="divide-y divide-amber-200/60 overflow-hidden rounded-md border border-amber-300/60 bg-amber-50/60 dark:divide-amber-900/40 dark:border-amber-900/50 dark:bg-amber-950/20">
      {alerts.map((a) => {
        const subject = (a.subjectName && a.subjectName.trim()) || a.subjectEmail || a.subjectUserId || "?"
        const kindLabel = (KNOWN_KINDS as readonly string[]).includes(a.kind)
          ? t(`kind.${a.kind}`)
          : a.kind
        // detail carries count / windowMin / share etc.; pass through for the message.
        const messageValues = {
          subject,
          project: a.projectName,
          count: Number(a.detail.count ?? 0),
          windowMin: Number(a.detail.windowMin ?? 60),
          share: Number(a.detail.share ?? 0),
        }
        const message = (KNOWN_KINDS as readonly string[]).includes(a.kind)
          ? t(`message.${a.kind}`, messageValues)
          : kindLabel

        // TODO(phase 10): point at the audit view, e.g.
        // `/projects/${a.projectSlug}/audit?subject=${a.subjectUserId}`. Until the
        // audit route exists, link to the project. The Review button (phase 09)
        // will be promoted to a ban dialog.
        const auditHref = `/projects/${a.projectSlug}`

        return (
          <li key={a.id} className="flex items-center gap-3 px-4 py-3">
            <ShieldAlertIcon className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link
                  href={`/projects/${a.projectSlug}`}
                  className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  {a.projectName}
                </Link>
                <span className="line-clamp-1 text-sm font-medium">{kindLabel}</span>
              </div>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{message}</p>
            </div>
            <Button size="sm" variant="outline" className="shrink-0" render={<Link href={auditHref} />}>
              {t("review")}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
