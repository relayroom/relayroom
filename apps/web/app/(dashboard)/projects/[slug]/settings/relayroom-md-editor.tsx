"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DEFAULT_RELAYROOM_MD } from "@relayroom/shared"
import { Button } from "@/components/ui/button"
import { updateRelayroomMd } from "@/modules/project/actions"

/**
 * Edit a project's RELAYROOM.md (the source of truth the `relayroom init` CLI
 * pulls). Empty/whitespace resets to the default template (stored as null).
 */
export function RelayroomMdEditor({
  projectId,
  initial,
}: {
  projectId: string
  initial: string | null
}) {
  const t = useTranslations("project")
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const base = initial ?? DEFAULT_RELAYROOM_MD
  const [content, setContent] = useState(base)
  const dirty = content !== base

  const save = () => {
    startTransition(async () => {
      const p = updateRelayroomMd({ projectId, content })
      toast.promise(p, {
        loading: t("settings.relayroomMd.saving"),
        success: (res) => {
          if (!res.result) throw new Error(res.message)
          router.refresh()
          return t("settings.relayroomMd.saved")
        },
        error: (err: Error) => err.message ?? t("settings.relayroomMd.saveError"),
      })
      await p.catch(() => {}) // keep the transition pending until the action settles
    })
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{t("settings.relayroomMd.title")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("settings.relayroomMd.description")}
        </p>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        rows={16}
        className="w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={isPending || !dirty}>
          {t("settings.relayroomMd.save")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setContent(DEFAULT_RELAYROOM_MD)}
          disabled={isPending}
        >
          {t("settings.relayroomMd.reset")}
        </Button>
      </div>
    </section>
  )
}
