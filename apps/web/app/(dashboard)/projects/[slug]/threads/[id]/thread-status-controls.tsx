"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon, XIcon, PauseIcon, MessageCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/use-confirm"
import { closeThread } from "@/modules/thread/actions"

interface ThreadStatusControlsProps {
  threadId: string
  status: string
  slug: string
}

export function ThreadStatusControls({ threadId, status, slug }: ThreadStatusControlsProps) {
  const router = useRouter()
  const t = useTranslations("project")
  const [isPending, startTransition] = useTransition()
  const { confirm, confirmDialog } = useConfirm()

  async function handleClose(newStatus: "open" | "closed" | "canceled" | "answered" | "holding") {
    const label = t(`threadStatus.${newStatus}`)

    const destructive = newStatus === "closed" || newStatus === "canceled"
    const ok = await confirm({
      title: t("threadStatus.confirmTitle", { action: label }),
      description: destructive
        ? t("threadStatus.confirmDestructive")
        : undefined,
      confirmText: label,
      destructive,
    })
    if (!ok) return

    const action = closeThread({ threadId, status: newStatus })
    toast.promise(action, {
      loading: t("threadStatus.toastChanging"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("threadStatus.genericError"))
        router.refresh()
        return t("threadStatus.toastChanged")
      },
      error: (err: unknown) => {
        const msg = err instanceof Error ? err.message : t("threadStatus.toastError")
        return msg
      },
    })

    startTransition(async () => {
      await action
    })
  }

  const isActive = status === "open" || status === "holding" || status === "answered"

  if (!isActive) return null

  // Cast to string to prevent TypeScript narrowing from making comparisons appear trivial
  const s: string = status

  return (
    <>
      {confirmDialog}
      <div className="flex items-center gap-2">
        {s !== "answered" && (
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => handleClose("answered")}
          >
            <CheckIcon className="h-3.5 w-3.5 mr-1.5" />
            {t("threadStatus.answered")}
          </Button>
        )}
        {s !== "holding" && (
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => handleClose("holding")}
          >
            <PauseIcon className="h-3.5 w-3.5 mr-1.5" />
            {t("threadStatus.holding")}
          </Button>
        )}
        {s !== "open" && (
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => handleClose("open")}
          >
            <MessageCircleIcon className="h-3.5 w-3.5 mr-1.5" />
            {t("threadStatus.open")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={() => handleClose("closed")}
          className="text-destructive hover:text-destructive"
        >
          <XIcon className="h-3.5 w-3.5 mr-1.5" />
          {t("threadStatus.closed")}
        </Button>
      </div>
    </>
  )
}
