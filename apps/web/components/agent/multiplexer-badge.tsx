"use client"

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, TerminalIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { MultiplexerDelivery } from "@/lib/multiplexer-status"

interface Props {
  multiplexer: MultiplexerDelivery
  /** A wake this part's pager took and never delivered. See `isDeliveryStalled`. */
  deliveryStalled: boolean
}

/**
 * What this part is running on, measured.
 *
 * NOT the connect dialog's selector. That value is what an operator asked for, and
 * this is what the pager found on the machine - the two disagree exactly when
 * something is worth showing, so sourcing this from intent would hide the only case
 * it exists for.
 *
 * NOTHING HERE RENDERS AS "healthy". The three things this can say are which
 * multiplexer is delivering, that it is not the one that was asked for, and that a
 * wake is visibly stuck. A part with no stuck wake may simply be a part nothing has
 * been sent to, so a green light would be a claim no measurement backs.
 */
export function MultiplexerBadge({ multiplexer, deliveryStalled }: Props) {
  const t = useTranslations("project")

  // Stuck delivery outranks which multiplexer is in use: the reader needs "wakes are
  // not arriving" before "and it is using tmux". Shown even when intent and active
  // agree, because a plain tmux part with no session is stuck in the same way.
  if (deliveryStalled) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive"
        title={t("agents.muxStalledHint")}
      >
        <AlertTriangleIcon className="h-3 w-3" />
        {t("agents.muxStalled")}
      </span>
    )
  }

  // Says nothing rather than guessing. A pager older than this measurement reports
  // neither value, and drawing "tmux" here would invent a reading from its silence.
  if (multiplexer.kind === "unreported") return null

  const degraded = multiplexer.kind === "degraded"

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]",
        degraded
          ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          : "bg-muted text-muted-foreground",
      )}
      title={
        degraded
          ? t("agents.muxDegradedHint", { intent: multiplexer.intent, active: multiplexer.via })
          : undefined
      }
    >
      <TerminalIcon className="h-3 w-3" />
      {multiplexer.via}
      {/* The asked-for value is shown struck through rather than dropped: "herdr"
          alone would read as a preference nobody acted on, and the point is that
          something was acted on and did not take. */}
      {degraded && (
        <span className="line-through opacity-70">{multiplexer.intent}</span>
      )}
    </span>
  )
}
