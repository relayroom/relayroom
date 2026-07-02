"use client"

import { useTranslations } from "next-intl"
import { useRealtime } from "@/components/realtime/realtime-provider"

/**
 * A transient "작성 중" (composing/typing) line for a thread. Reads the live
 * composing state from the realtime provider; renders nothing until an agent
 * signals it is replying, and fades on its own when the signal stops (TTL).
 * Best-effort: agent-emitted, so it may not always show.
 */
export function ComposingIndicator({
  threadId,
  parts,
}: {
  threadId: string
  parts: string[]
}) {
  const t = useTranslations("project")
  const rt = useRealtime()
  if (!rt) return null
  const active = parts.filter((p) => rt.isComposing(threadId, p))
  if (active.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5" aria-live="polite">
      {active.map((p) => (
        <span key={p} className="text-xs text-muted-foreground font-mono animate-pulse">
          {t("threadDetail.composing", { part: p })}
        </span>
      ))}
    </div>
  )
}
