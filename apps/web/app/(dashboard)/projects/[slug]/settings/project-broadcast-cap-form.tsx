"use client"

import { useState, useTransition } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LabeledSlider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { updateBroadcastCap } from "@/modules/wake/actions"

interface Props {
  projectId: string
  initial: number | null
  partCount: number
  canManage: boolean
}

export function ProjectBroadcastCapForm({ projectId, initial, partCount, canManage }: Props) {
  const t = useTranslations("wake")
  const [isPending, startTransition] = useTransition()
  // null = "auto" (runtime min(N, 8)); preview that computed default in the slider.
  const computedDefault = Math.min(partCount, 8)
  const [isAuto, setIsAuto] = useState(initial == null)
  const [value, setValue] = useState(initial ?? computedDefault)
  const sliderMax = Math.max(8, partCount)

  function save(next: number | null) {
    startTransition(async () => {
      const p = updateBroadcastCap({ projectId, maxBroadcastRecipients: next })
      toast.promise(p, {
        loading: t("project.toastSaving"),
        success: (res) => {
          if (!res.result) throw new Error(res.message ?? undefined)
          return t("project.toastSaved")
        },
        error: (e: Error) => e.message ?? t("project.toastError"),
      })
      await p.catch(() => {}) // keep the transition pending until the action settles
    })
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{t("project.sectionTitle")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t("project.sectionDescription")}</p>
      </div>

      <LabeledSlider
        label={t("project.maxRecipientsLabel")}
        value={value}
        min={1}
        max={sliderMax}
        disabled={isPending || !canManage}
        onValueChange={(v) => {
          setIsAuto(false)
          setValue(v)
        }}
        onValueCommitted={(v) => canManage && save(v)}
      />

      {isAuto && (
        <p className="text-xs text-muted-foreground">
          {t("project.autoHint", { n: computedDefault })}
        </p>
      )}

      {!canManage ? (
        <p className="text-xs text-muted-foreground">{t("project.managerOnly")}</p>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={isPending || isAuto}
          onClick={() => {
            setIsAuto(true)
            setValue(computedDefault)
            save(null)
          }}
        >
          {t("project.autoButton")}
        </Button>
      )}
    </div>
  )
}
