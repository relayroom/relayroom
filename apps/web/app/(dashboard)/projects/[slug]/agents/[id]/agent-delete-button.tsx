"use client"

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Trash2Icon } from "lucide-react"
import { useConfirm } from "@/components/ui/use-confirm"
import { Button } from "@/components/ui/button"
import { deleteAgent } from "@/modules/agent/actions"

export function AgentDeleteButton({ agentId, part, slug }: { agentId: string; part: string; slug: string }) {
  const router = useRouter()
  const t = useTranslations("project")
  const { confirm, confirmDialog } = useConfirm()

  async function handleDelete() {
    const ok = await confirm({
      title: t("agentDelete.confirmTitle"),
      description: t("agentDelete.confirmDescription", { part }),
      confirmText: t("agentDelete.confirmText"),
      destructive: true,
    })
    if (!ok) return

    await toast.promise(deleteAgent(agentId), {
      loading: t("agentDelete.toastLoading"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? undefined)
        router.push(`/projects/${slug}/agents`)
        return t("agentDelete.toastSuccess")
      },
      error: (err: unknown) => (err instanceof Error ? err.message : t("agentDelete.toastError")),
    })
  }

  return (
    <>
      {confirmDialog}
      <Button
        variant="outline"
        size="sm"
        onClick={handleDelete}
        className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2Icon className="mr-1.5 h-3.5 w-3.5" />
        {t("agentDelete.button")}
      </Button>
    </>
  )
}
