"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { dismissAttention } from "@/modules/thread/actions"
import { ThreadMeta } from "./thread-meta"

export interface AttentionThread {
  id: string
  subject: string
  projectSlug: string
  projectName: string
  status: string
  createdByAgentPart: string | null
  createdByHuman: boolean
  messageCount: number
  lastActorPart: string | null
  lastActorHuman: boolean
  updatedAt: string
}

/**
 * The bell's real queue: threads an agent flagged as needing a human. Each row
 * links to the thread (replying clears the flag server-side) and offers a
 * one-click Dismiss to acknowledge without replying.
 */
export function AttentionList({ threads }: { threads: AttentionThread[] }) {
  const t = useTranslations("inbox")
  const router = useRouter()

  async function onDismiss(threadId: string) {
    await toast.promise(dismissAttention({ threadId }), {
      loading: t("toastDismissing"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("toastDismissError"))
        router.refresh()
        return t("toastDismissed")
      },
      error: (err: unknown) =>
        err instanceof Error ? err.message : t("toastDismissError"),
    })
  }

  return (
    <ul className="divide-y divide-amber-200/60 overflow-hidden rounded-md border border-amber-300/60 bg-amber-50/60 dark:divide-amber-900/40 dark:border-amber-900/50 dark:bg-amber-950/20">
      {threads.map((thread) => (
        <li key={thread.id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Link
                href={`/projects/${thread.projectSlug}`}
                className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                {thread.projectName}
              </Link>
              <Link
                href={`/projects/${thread.projectSlug}/threads/${thread.id}`}
                className="line-clamp-1 text-sm font-medium hover:underline"
              >
                {thread.subject}
              </Link>
            </div>
            <ThreadMeta
              status={thread.status}
              createdByAgentPart={thread.createdByAgentPart}
              createdByHuman={thread.createdByHuman}
              messageCount={thread.messageCount}
              lastActorPart={thread.lastActorPart}
              lastActorHuman={thread.lastActorHuman}
              updatedAt={thread.updatedAt}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => onDismiss(thread.id)}
          >
            <CheckIcon className="mr-1.5 h-3.5 w-3.5" />
            {t("dismiss")}
          </Button>
        </li>
      ))}
    </ul>
  )
}
