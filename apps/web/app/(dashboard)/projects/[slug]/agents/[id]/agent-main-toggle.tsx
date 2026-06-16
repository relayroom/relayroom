"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { StarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/use-confirm"
import { setMainAgent } from "@/modules/agent/actions"

interface AgentMainToggleProps {
  agentId: string
  isMain: boolean
  /** Human label for THIS agent (nickname or part), shown in the switch prompt. */
  nextPart?: string
  /**
   * Label of the caller's existing main in this project, or null if none (or if
   * it is this agent). When set, clicking "Set as main" asks for confirmation
   * before replacing the existing main.
   */
  existingMainPart?: string | null
}

export function AgentMainToggle({ agentId, isMain, nextPart, existingMainPart }: AgentMainToggleProps) {
  const router = useRouter()
  const t = useTranslations("project")
  const { confirm, confirmDialog } = useConfirm()
  const [isPending, startTransition] = useTransition()

  if (isMain) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
        <StarIcon className="h-3 w-3 fill-current" />
        {t("agentMainToggle.mainLabel")}
      </span>
    )
  }

  function runSetMain() {
    const action = setMainAgent(agentId)

    toast.promise(action, {
      loading: t("agentMainToggle.toastSetting"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("agentMainToggle.genericError"))
        router.refresh()
        return t("agentMainToggle.toastSet")
      },
      error: (err: unknown) => {
        const msg = err instanceof Error ? err.message : t("agentMainToggle.toastError")
        return msg
      },
    })

    startTransition(async () => {
      await action
    })
  }

  async function handleSetMain() {
    // When the caller already has a main in this project, confirm the swap first.
    if (existingMainPart) {
      const ok = await confirm({
        title: t("agentMainToggle.confirmSwitchTitle"),
        description: t("agentMainToggle.confirmSwitchDescription", {
          existing: existingMainPart,
          next: nextPart ?? "",
        }),
        confirmText: t("agentMainToggle.confirmSwitchText"),
      })
      if (!ok) return
    }
    runSetMain()
  }

  return (
    <>
      {confirmDialog}
      <Button variant="outline" size="sm" disabled={isPending} onClick={handleSetMain}>
        <StarIcon className="h-3.5 w-3.5 mr-1.5" />
        {t("agentMainToggle.setMainButton")}
      </Button>
    </>
  )
}
