"use client"

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { timeAgo } from "@/lib/format"

export interface ThreadMetaProps {
  status: string
  createdByAgentPart: string | null
  createdByHuman: boolean
  messageCount: number
  lastActorPart: string | null
  lastActorHuman: boolean
  updatedAt: string
}

const STATUS_STYLE: Record<string, string> = {
  open: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  answered: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  holding: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

/**
 * One-line metadata for an inbox thread: status (question / answered / ongoing),
 * who opened it, how many messages, who spoke last, and when. Lets the operator
 * tell at a glance whether a thread is a fresh question or a live conversation,
 * and which agent it came from — since the inbox aggregates across projects.
 */
export function ThreadMeta({
  status,
  createdByAgentPart,
  createdByHuman,
  messageCount,
  lastActorPart,
  lastActorHuman,
  updatedAt,
}: ThreadMetaProps) {
  const t = useTranslations("inbox")

  const opener = createdByHuman
    ? t("you")
    : createdByAgentPart ?? t("anAgent")
  const statusKey = ["open", "answered", "holding"].includes(status)
    ? status
    : null
  const lastActor = lastActorHuman
    ? t("you")
    : lastActorPart ?? null

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {statusKey && (
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
            STATUS_STYLE[statusKey],
          )}
        >
          {t(`status_${statusKey}`)}
        </span>
      )}
      <span>{t("openedBy", { who: opener })}</span>
      <span aria-hidden>·</span>
      <span>{t("messages", { count: messageCount })}</span>
      {messageCount > 1 && lastActor && (
        <>
          <span aria-hidden>·</span>
          <span>{t("lastFrom", { who: lastActor })}</span>
        </>
      )}
      <span aria-hidden>·</span>
      <span className="font-mono">{timeAgo(updatedAt)}</span>
    </div>
  )
}
