"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { UnplugIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/use-confirm"
import { disconnectConnection } from "@/modules/agent/actions"

interface AgentConnectionDisconnectButtonProps {
  connectionId: string
  machineLabel: string | null
}

export function AgentConnectionDisconnectButton({
  connectionId,
  machineLabel,
}: AgentConnectionDisconnectButtonProps) {
  const router = useRouter()
  const t = useTranslations("project")
  const [isPending, startTransition] = useTransition()
  const { confirm, confirmDialog } = useConfirm()

  async function handleDisconnect() {
    const ok = await confirm({
      title: t("agentConnectionDisconnect.confirmTitle"),
      description: machineLabel
        ? t("agentConnectionDisconnect.confirmDescriptionWithLabel", { machineLabel })
        : t("agentConnectionDisconnect.confirmDescriptionNoLabel"),
      confirmText: t("agentConnectionDisconnect.confirmText"),
      destructive: true,
    })
    if (!ok) return

    const action = disconnectConnection(connectionId)
    toast.promise(action, {
      loading: t("agentConnectionDisconnect.toastLoading"),
      success: (res) => {
        if (!res.result) throw new Error(res.message ?? t("agentConnectionDisconnect.toastError"))
        router.refresh()
        return t("agentConnectionDisconnect.toastSuccess")
      },
      error: (err: unknown) => {
        const msg = err instanceof Error ? err.message : t("agentConnectionDisconnect.toastError")
        return msg
      },
    })

    startTransition(async () => {
      await action
    })
  }

  return (
    <>
      {confirmDialog}
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={handleDisconnect}
        className="text-destructive hover:text-destructive"
      >
        <UnplugIcon className="h-3.5 w-3.5" />
        <span className="sr-only">{t("agentConnectionDisconnect.srLabel")}</span>
      </Button>
    </>
  )
}
