"use client"

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { UnplugIcon } from "lucide-react"
import { useConfirm } from "@/components/ui/use-confirm"
import { Button } from "@/components/ui/button"
import { disconnectConnection } from "@/modules/agent/actions"

interface Props {
  connectionId: string
  partName: string
}

export function AgentDisconnectButton({ connectionId, partName }: Props) {
  const router = useRouter()
  const t = useTranslations("project")
  const { confirm, confirmDialog } = useConfirm()

  async function handleDisconnect() {
    const ok = await confirm({
      title: t("agentDisconnect.confirmTitle"),
      description: t("agentDisconnect.confirmDescription", { partName }),
      confirmText: t("agentDisconnect.confirmText"),
      destructive: true,
    })
    if (!ok) return

    await toast.promise(disconnectConnection(connectionId), {
      loading: t("agentDisconnect.toastLoading"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? undefined)
        router.refresh()
        return t("agentDisconnect.toastSuccess")
      },
      error: (err: unknown) =>
        err instanceof Error ? err.message : t("agentDisconnect.toastError"),
    })
  }

  return (
    <>
      {confirmDialog}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDisconnect}
        className="text-muted-foreground hover:text-destructive"
        aria-label={t("agentDisconnect.ariaLabel", { partName })}
      >
        <UnplugIcon className="h-4 w-4" />
      </Button>
    </>
  )
}
