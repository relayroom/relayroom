"use client"

import { useEffect, useState } from "react"
import { TimerIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { useRealtime } from "@/components/realtime/realtime-provider"

/**
 * Small amber badge shown while an agent is parked on a provider rate-limit.
 * Renders nothing once `limitedUntil` is null or in the past. A self-clearing
 * timer hides the badge the moment the limit lifts, without waiting for a
 * page refresh or a live "limited" event.
 */
export function LimitedBadge({
  part,
  limitedUntil,
  className,
}: {
  /** The agent part this badge is for - matches HubLimitedEvent.part. */
  part: string
  /** ISO timestamp the limit lifts, or null. Server-rendered snapshot. */
  limitedUntil: string | null
  className?: string
}) {
  const t = useTranslations("common")
  const realtime = useRealtime()
  const live = realtime?.limitedUntil(part)
  // Live event wins once we have one for this part; otherwise fall back to the
  // server-rendered snapshot. `live === null` means a live "cleared" signal.
  const effective = live !== undefined ? live : limitedUntil

  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!effective) return
    const until = new Date(effective).getTime()
    const delay = until - Date.now()
    if (delay <= 0) return
    const id = setTimeout(() => setNow(Date.now()), delay + 100)
    return () => clearTimeout(id)
  }, [effective])

  if (!effective) return null
  const until = new Date(effective).getTime()
  if (until <= now) return null

  const label = t("limited.badge", {
    time: new Date(effective).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  })

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
        className,
      )}
    >
      <TimerIcon className="h-3 w-3" />
      {label}
    </span>
  )
}
