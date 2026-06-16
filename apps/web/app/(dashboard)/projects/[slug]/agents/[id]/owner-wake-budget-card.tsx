"use client"

import { useState, useTransition } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LabeledSlider } from "@/components/ui/slider"
import { upsertOwnerWakeBudget } from "@/modules/wake/actions"

interface Props {
  initial: { wakesPerHour: number; urgentPerHour: number }
}

export function OwnerWakeBudgetCard({ initial }: Props) {
  const t = useTranslations("wake")
  const [isPending, startTransition] = useTransition()
  const [wakesPerHour, setWakesPerHour] = useState(initial.wakesPerHour)
  const [urgentPerHour, setUrgentPerHour] = useState(initial.urgentPerHour)

  function save(next: { wakesPerHour: number; urgentPerHour: number }) {
    startTransition(async () => {
      const p = upsertOwnerWakeBudget(next)
      toast.promise(p, {
        loading: t("owner.toastSaving"),
        success: (res) => {
          if (!res.result) throw new Error(res.message ?? undefined)
          return t("owner.toastSaved")
        },
        error: (e: Error) => e.message ?? t("owner.toastError"),
      })
      await p.catch(() => {}) // keep the transition pending until the action settles
    })
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="space-y-1">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t("owner.sectionTitle")}
        </p>
        <p className="text-xs text-muted-foreground">{t("owner.sectionDescription")}</p>
      </div>

      <LabeledSlider
        label={t("owner.wakesLabel")}
        value={wakesPerHour}
        min={0}
        max={240}
        disabled={isPending}
        onValueChange={setWakesPerHour}
        onValueCommitted={(v) => save({ wakesPerHour: v, urgentPerHour })}
      />

      <div className="space-y-1">
        <LabeledSlider
          label={t("owner.urgentLabel")}
          value={urgentPerHour}
          min={0}
          max={60}
          disabled={isPending}
          onValueChange={setUrgentPerHour}
          onValueCommitted={(v) => save({ wakesPerHour, urgentPerHour: v })}
        />
        {urgentPerHour === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("owner.urgentZeroHint")}</p>
        )}
      </div>
    </div>
  )
}
