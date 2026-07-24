"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { RotateCcwIcon, Loader2Icon, ChevronDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/use-confirm"
import { rollbackPlaybookAction } from "@/modules/knowledge/proposal-actions"

export interface VersionRow {
  version: number
  content: string
  note: string | null
  createdLabel: string
}

interface Props {
  projectId: string
  /** The currently served body, to diff a version against. */
  currentContent: string
  /** Version history, newest first. The first is the current one. */
  versions: VersionRow[]
}

/**
 * Owner control to roll the served playbook back to a prior version.
 *
 * Rolling back is append-only (a new version equal to an old one), so it is not
 * destructive - but it does change what agents are served, so the confirm shows
 * which version and whether it actually differs from the current body. Same
 * sensibility as the purge two-number confirm: not dangerous, but never silent
 * about what changes.
 */
export function RollbackControl({ projectId, currentContent, versions }: Props) {
  const t = useTranslations("project")
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [pending, setPending] = useState<number | null>(null)
  const [openDiff, setOpenDiff] = useState<number | null>(null)

  async function onRollback(v: VersionRow) {
    const identical = v.content === currentContent
    const ok = await confirm({
      title: t("knowledgeRollback.confirmTitle", { version: v.version }),
      description: identical
        ? t("knowledgeRollback.noChange")
        : t("knowledgeRollback.confirmBody"),
    })
    if (!ok) return

    setPending(v.version)
    const request = rollbackPlaybookAction(projectId, v.version).then((res) => {
      if (!res.result) throw new Error(res.message ?? t("knowledgeRollback.done", { version: v.version }))
      return res
    })
    toast.promise(request, {
      loading: t("knowledgeRollback.pending"),
      success: () => {
        router.refresh()
        return t("knowledgeRollback.done", { version: v.version })
      },
      error: (err: unknown) => (err instanceof Error ? err.message : t("knowledgeRollback.done", { version: v.version })),
    })
    await request.catch(() => {})
    setPending(null)
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      {confirmDialog}
      <div>
        <h2 className="text-sm font-semibold">{t("knowledgeRollback.title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("knowledgeRollback.description")}</p>
      </div>

      {versions.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("knowledgeRollback.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {versions.map((v, i) => {
            const isCurrent = i === 0
            return (
              <li key={v.version} className="px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{t("knowledgeRollback.versionLabel", { version: v.version })}</span>
                  {isCurrent && (
                    <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium">
                      {t("knowledgeRollback.current")}
                    </span>
                  )}
                  {v.note && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{v.note}</span>}
                  <span className="ml-auto shrink-0 text-[11px] font-mono text-muted-foreground">{v.createdLabel}</span>
                  {!isCurrent && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenDiff(openDiff === v.version ? null : v.version)}
                      >
                        <ChevronDownIcon className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => onRollback(v)} disabled={pending !== null}>
                        {pending === v.version ? (
                          <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcwIcon className="mr-1 h-3.5 w-3.5" />
                        )}
                        {t("knowledgeRollback.rollbackButton")}
                      </Button>
                    </>
                  )}
                </div>

                {openDiff === v.version && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-[10px] font-medium uppercase text-muted-foreground/70">
                        {t("knowledgeRollback.diffCurrent")}
                      </p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">
                        {currentContent}
                      </pre>
                    </div>
                    <div>
                      <p className="mb-1 text-[10px] font-medium uppercase text-muted-foreground/70">
                        {t("knowledgeRollback.diffTarget", { version: v.version })}
                      </p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">
                        {v.content}
                      </pre>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
