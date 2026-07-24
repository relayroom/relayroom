"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Trash2Icon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/use-confirm"
import { purgeThreadKnowledge } from "@/modules/knowledge/purge-actions"

export interface PurgeableThreadRow {
  threadId: string
  subject: string | null
  entryCount: number
}

interface Props {
  projectId: string
  threads: PurgeableThreadRow[]
}

/**
 * Owner surface for purging a thread's derived knowledge.
 *
 * The flow makes the irreversibility legible: clicking a row's Purge first runs
 * the action in dry-run to get the exact {deleted, detached} the real purge will
 * produce, then shows those two numbers in the confirm. Because the preview and
 * the purge are the same server function with a flag flipped, the confirm cannot
 * promise one thing and the purge do another.
 */
export function ThreadPurgeManager({ projectId, threads }: Props) {
  const t = useTranslations("project")
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function onPurge(row: PurgeableThreadRow) {
    setBusyId(row.threadId)
    try {
      // Dry-run first: the confirm must state the real counts, and only the
      // function knows the deleted/detached split.
      const preview = await purgeThreadKnowledge(projectId, row.threadId, true)
      if (!preview.result) {
        toast.error(preview.message ?? t("knowledgePurge.done"))
        return
      }
      const { deleted, detached } = preview.item

      const ok = await confirm({
        title: t("knowledgePurge.confirmTitle"),
        description:
          deleted + detached === 0
            ? t("knowledgePurge.confirmBodyNothing")
            : t("knowledgePurge.confirmBody", { deleted, detached }),
        destructive: true,
        // Nothing to purge: still let them dismiss, but there is no destructive act.
      })
      if (!ok) return

      if (deleted + detached === 0) {
        toast.message(t("knowledgePurge.doneNothing"))
        router.refresh()
        return
      }

      const request = purgeThreadKnowledge(projectId, row.threadId, false).then((res) => {
        if (!res.result) throw new Error(res.message ?? t("knowledgePurge.done"))
        return res
      })
      toast.promise(request, {
        loading: t("knowledgePurge.pending"),
        success: (res) => {
          router.refresh()
          return res.result
            ? t("knowledgePurge.done", { deleted: res.item.deleted, detached: res.item.detached })
            : t("knowledgePurge.doneNothing")
        },
        error: (err: unknown) => (err instanceof Error ? err.message : t("knowledgePurge.done")),
      })
      await request.catch(() => {})
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      {confirmDialog}
      <div>
        <h2 className="text-sm font-semibold">{t("knowledgePurge.title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("knowledgePurge.description")}</p>
      </div>

      {threads.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("knowledgePurge.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {threads.map((row) => (
            <li key={row.threadId} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {row.subject || t("knowledgePurge.untitledThread")}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {t("knowledgePurge.colEntries")}: {row.entryCount}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPurge(row)}
                disabled={busyId !== null}
              >
                {busyId === row.threadId ? (
                  <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2Icon className="mr-1 h-3.5 w-3.5" />
                )}
                {t("knowledgePurge.purgeButton")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
