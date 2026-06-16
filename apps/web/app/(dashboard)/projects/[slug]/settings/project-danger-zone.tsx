"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ArchiveIcon } from "lucide-react"
import { archiveProject } from "@/modules/project/actions"
import { useConfirm } from "@/components/ui/use-confirm"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

interface Props {
  projectId: string
}

/** Project danger zone (archive). Split out of the settings form so the page can
 *  render it as the LAST section - destructive actions belong at the bottom. */
export function ProjectDangerZone({ projectId }: Props) {
  const router = useRouter()
  const t = useTranslations("project")
  const [isPending, startTransition] = useTransition()
  const { confirm, confirmDialog } = useConfirm()

  async function handleArchive() {
    const ok = await confirm({
      title: t("settings.danger.confirmTitle"),
      description: t("settings.danger.confirmDescription"),
      confirmText: t("settings.danger.confirmText"),
      destructive: true,
    })
    if (!ok) return

    startTransition(async () => {
      const p = archiveProject(projectId)
      toast.promise(p, {
        loading: t("settings.danger.toastArchiving"),
        success: (res) => {
          if (!res.result) throw new Error(res.message ?? t("settings.danger.toastError"))
          router.push("/projects")
          return t("settings.danger.toastArchived")
        },
        error: (err: Error) => err.message ?? t("settings.danger.toastError"),
      })
      await p.catch(() => {}) // keep the transition pending until the action settles
    })
  }

  // Matches the agent-detail danger zone: a separator + extra top gap, then a card
  // with a destructive header. Keeps destructive sections visually consistent.
  return (
    <div className="pt-4">
      {confirmDialog}
      <Separator />
      <div className="mt-8 rounded-lg border border-destructive/30">
        <div className="border-b border-destructive/20 px-5 py-3">
          <h2 className="text-sm font-semibold text-destructive">{t("settings.danger.sectionTitle")}</h2>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("settings.danger.archiveTitle")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.danger.archiveDescription")}</p>
          </div>
          <Button variant="destructive" size="sm" onClick={handleArchive} disabled={isPending}>
            <ArchiveIcon className="h-4 w-4 mr-1.5" />
            {t("settings.danger.archiveButton")}
          </Button>
        </div>
      </div>
    </div>
  )
}
