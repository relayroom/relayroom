"use client"

import { SatelliteDishIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { timeAgo } from "@/lib/format"
import { useRealtime } from "@/components/realtime/realtime-provider"

/**
 * Pager liveness indicator: a satellite-dish icon (green when online, muted when
 * offline) with an instant (delay 0) tooltip. `status` is the server-rendered
 * value at load; inside a RealtimeProvider it flips live as pager beats arrive
 * (online instantly, offline after the heartbeat gap). Self-contained i18n.
 */
export function PagerStatusIcon({
  agentId,
  status,
  className,
}: {
  agentId: string
  status: boolean
  className?: string
}) {
  const t = useTranslations("common")
  const realtime = useRealtime()
  // Live status wins once we have a signal; otherwise fall back to the server value.
  const live = realtime?.pagerOnline(agentId)
  const online = live ?? status
  const label = online ? t("pager.online") : t("pager.offline")

  return (
    <TooltipProvider delay={0}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "inline-flex shrink-0 cursor-default items-center",
                online ? "text-emerald-500" : "text-muted-foreground/40",
                className,
              )}
              aria-label={label}
            />
          }
        >
          <SatelliteDishIcon className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Inline pager badge: the live icon plus an online/offline word and the last-seen
 * time. Used on the agent detail page where the status deserves a label. The
 * icon + word flip live via the RealtimeProvider; the last-seen text is the
 * server value at load (refreshed on the next route refresh).
 */
export function PagerStatusBadge({
  agentId,
  status,
  lastSeenAt,
}: {
  agentId: string
  status: boolean
  /** ISO string of the last pager beat, or null. */
  lastSeenAt: string | null
}) {
  const t = useTranslations("common")
  const realtime = useRealtime()
  const online = realtime?.pagerOnline(agentId) ?? status

  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      <PagerStatusIcon agentId={agentId} status={status} />
      <span className={online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/70"}>
        {online ? t("pager.online") : t("pager.offline")}
      </span>
      {lastSeenAt && <span className="text-muted-foreground/60">· {timeAgo(lastSeenAt)}</span>}
    </span>
  )
}
