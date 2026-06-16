"use client"

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

export type AgentStatus = "working" | "idle" | "offline" | "error"

const STYLES: Record<AgentStatus, { dot: string; text: string; pulse?: boolean }> = {
  working: { dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400", pulse: true },
  idle: { dot: "bg-emerald-500", text: "text-muted-foreground" },
  offline: { dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
  error: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
}

/**
 * Live activity status for an agent (derived from connection state + the most
 * recent event). Updates as the page refreshes from the project SSE stream.
 */
export function AgentStatusBadge({
  status,
  className,
}: {
  status: AgentStatus
  className?: string
}) {
  const t = useTranslations("common")
  const s = STYLES[status]
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", s.text, className)}>
      <span className={cn("inline-block h-2 w-2 rounded-full", s.dot, s.pulse && "animate-pulse")} />
      {t(`agentStatus.${status}`)}
    </span>
  )
}
