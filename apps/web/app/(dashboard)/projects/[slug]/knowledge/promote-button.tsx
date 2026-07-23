"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/use-confirm"
import { promoteKnowledge } from "@/modules/knowledge/actions"

/**
 * Owner-only "Confirm" on a candidate claim.
 *
 * Behind a confirmation dialog even though it is not a delete. It cannot be
 * undone from this screen - L0 has no demote button, and a trusted claim is only
 * unwound by contradicting evidence - and it writes a permanent audit row naming
 * the person who did it. Something irreversible that goes into a ledger is not
 * something to fire on a stray click.
 */
export function PromoteButton({
  projectId,
  knowledgeId,
}: {
  projectId: string
  knowledgeId: string
}) {
  const t = useTranslations("project")
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [pending, setPending] = useState(false)

  async function onClick() {
    const ok = await confirm({
      title: t("knowledgePromote.confirmTitle"),
      description: t("knowledgePromote.confirmBody"),
    })
    if (!ok) return

    setPending(true)
    // Await the action, not toast.promise (which returns a toast id), so the
    // button stays disabled until the write actually settles.
    const request = promoteKnowledge({ projectId, knowledgeId }).then((res) => {
      if (!res.result) throw new Error(res.message ?? t("knowledgePromote.toastError"))
      return res
    })

    toast.promise(request, {
      loading: t("knowledgePromote.toastPending"),
      success: () => {
        router.refresh()
        return t("knowledgePromote.toastDone")
      },
      error: (err: unknown) =>
        err instanceof Error ? err.message : t("knowledgePromote.toastError"),
    })

    await request.catch(() => {})
    setPending(false)
  }

  return (
    <>
      {confirmDialog}
      <Button size="sm" variant="outline" onClick={onClick} disabled={pending}>
        {pending ? (
          <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <CheckIcon className="mr-1 h-3.5 w-3.5" />
        )}
        {t("knowledgePromote.button")}
      </Button>
    </>
  )
}
