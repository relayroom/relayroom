"use client"

import { useRealtime } from "@/components/realtime/realtime-provider"

/**
 * A small online/offline dot for an agent part. The server passes the initial
 * state (pager heartbeat at query time); when a live SSE pager signal exists it
 * wins, so the dot flips online/offline without a page refresh. Labels are passed
 * in already-translated so the label stays in sync with the live state.
 */
export function PresenceDot({
  agentId,
  initialOnline,
  onlineLabel,
  offlineLabel,
}: {
  agentId: string
  initialOnline: boolean
  onlineLabel: string
  offlineLabel: string
}) {
  const rt = useRealtime()
  const live = rt?.pagerOnline(agentId)
  const online = live ?? initialOnline
  const label = online ? onlineLabel : offlineLabel
  return (
    <span
      className={[
        "inline-block h-1.5 w-1.5 rounded-full shrink-0",
        online ? "bg-emerald-500" : "bg-muted-foreground/40",
      ].join(" ")}
      title={label}
      aria-label={label}
    />
  )
}
