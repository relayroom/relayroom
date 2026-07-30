"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Trash2Icon, Loader2Icon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useConfirm } from "@/components/ui/use-confirm"
import { purgeThreadKnowledge, searchPurgeableThreads } from "@/modules/knowledge/purge-actions"
import { THREAD_SEARCH_LIMIT } from "@/modules/knowledge/purge-constants"

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
 * The flow makes the irreversibility legible: clicking Purge first runs the action
 * in dry-run to get the outcome the real purge will produce, then states it in the
 * confirm. Because the preview and the purge are the same server function with a
 * flag flipped, the confirm cannot promise one thing and the purge do another.
 *
 * The result is a discriminated union, so this component cannot read a count
 * without first deciding whether the purge covered everything. Do not flatten it
 * back into a set of fields to read: the previous shape returned a `detached`
 * count that this component rendered correctly and users still misread, because a
 * number beside "deleted" looks like another kind of removal. A branch has to be
 * taken; a field only has to be remembered.
 */
export function ThreadPurgeManager({ projectId, threads }: Props) {
  const t = useTranslations("project")
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  // null = no search has been run yet, so neither results nor "no matches" applies.
  const [results, setResults] = useState<PurgeableThreadRow[] | null>(null)

  async function onSearch() {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      const res = await searchPurgeableThreads(projectId, q)
      if (!res.result) {
        toast.error(res.message ?? t("knowledgePurge.done"))
        return
      }
      setResults(res.items)
    } finally {
      setSearching(false)
    }
  }

  async function onPurge(row: PurgeableThreadRow) {
    setBusyId(row.threadId)
    try {
      // Dry-run first: the confirm must state the real count, and only the
      // function knows it.
      const preview = await purgeThreadKnowledge(projectId, row.threadId, true)
      if (!preview.result) {
        toast.error(preview.message ?? t("knowledgePurge.done"))
        return
      }
      // `complete: false` means some entries cannot be removed because another
      // thread also derived them. Unreachable today - nothing writes a
      // multi-source entry - but the union makes the case impossible to forget
      // rather than a field someone has to remember to read, which is exactly how
      // the old `detached` count misled while being rendered correctly.
      const deleted = preview.item.deleted
      const refused = preview.item.complete ? 0 : preview.item.refused.length

      const ok = await confirm({
        title: t("knowledgePurge.confirmTitle"),
        // Zero does NOT mean nothing happens. A purge also records that this
        // thread must not be extracted again, and that record is the entire point
        // when nothing is left to delete - the thread was purged before and the
        // knowledge came back. So the zero copy describes what will be written
        // rather than reporting an absence.
        description:
          refused > 0
            ? t("knowledgePurge.confirmBodyPartial", { deleted, refused })
            : deleted === 0
              ? t("knowledgePurge.confirmBodyNothing")
              : t("knowledgePurge.confirmBody", { deleted }),
        destructive: true,
      })
      if (!ok) return

      // No early return on zero. It was correct while purge only deleted rows -
      // running it would have been a genuine no-op. Now purge also writes the
      // suppression, so stopping here would silently skip the one operation the
      // operator came for, on exactly the threads that need it.
      const request = purgeThreadKnowledge(projectId, row.threadId, false).then((res) => {
        if (!res.result) throw new Error(res.message ?? t("knowledgePurge.done"))
        return res
      })
      toast.promise(request, {
        loading: t("knowledgePurge.pending"),
        success: (res) => {
          router.refresh()
          if (!res.result) return t("knowledgePurge.doneNothing")
          if (!res.item.complete) {
            return t("knowledgePurge.donePartial", {
              deleted: res.item.deleted,
              refused: res.item.refused.length,
            })
          }
          return res.item.deleted === 0
            ? t("knowledgePurge.doneNothing")
            : t("knowledgePurge.done", { deleted: res.item.deleted })
        },
        error: (err: unknown) => (err instanceof Error ? err.message : t("knowledgePurge.done")),
      })
      await request.catch(() => {})
    } finally {
      setBusyId(null)
    }
  }

  function renderRow(row: PurgeableThreadRow) {
    return (
      <li key={row.threadId} className="flex items-center gap-3 px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate">
          {row.subject || t("knowledgePurge.untitledThread")}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {/* A searched thread can legitimately have none, which is the case the
              search exists for - say so in words rather than showing "Entries: 0",
              which reads as a thread not worth purging. */}
          {row.entryCount === 0
            ? t("knowledgePurge.noEntries")
            : `${t("knowledgePurge.colEntries")}: ${row.entryCount}`}
        </span>
        <Button size="sm" variant="outline" onClick={() => onPurge(row)} disabled={busyId !== null}>
          {busyId === row.threadId ? (
            <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2Icon className="mr-1 h-3.5 w-3.5" />
          )}
          {t("knowledgePurge.purgeButton")}
        </Button>
      </li>
    )
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
          {threads.map(renderRow)}
        </ul>
      )}

      {/* The list above is built from knowledge that still cites a thread, so a
          thread already purged once cannot appear in it - and that is exactly the
          thread someone needs when purged knowledge has come back. Search reaches
          it, because it starts from threads rather than from knowledge. */}
      <div className="space-y-2 border-t border-border pt-3">
        <div>
          <h3 className="text-xs font-semibold">{t("knowledgePurge.searchLabel")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("knowledgePurge.searchHint")}</p>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void onSearch()
          }}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("knowledgePurge.searchPlaceholder")}
            disabled={searching || busyId !== null}
            className="h-8 text-sm"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={searching || busyId !== null || query.trim() === ""}
          >
            {searching ? (
              <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <SearchIcon className="mr-1 h-3.5 w-3.5" />
            )}
            {searching ? t("knowledgePurge.searching") : t("knowledgePurge.searchButton")}
          </Button>
        </form>

        {results !== null &&
          (results.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
              {t("knowledgePurge.searchNoResults")}
            </p>
          ) : (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("knowledgePurge.searchResultsTitle")}</p>
              <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                {results.map(renderRow)}
              </ul>
              {results.length >= THREAD_SEARCH_LIMIT && (
                <p className="text-xs text-muted-foreground">
                  {t("knowledgePurge.searchTruncated", { limit: THREAD_SEARCH_LIMIT })}
                </p>
              )}
            </div>
          ))}
      </div>
    </section>
  )
}
