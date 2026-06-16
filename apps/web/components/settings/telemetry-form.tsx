"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { setTelemetryMode } from "@/modules/telemetry/actions"
import type { TelemetryMode } from "@/modules/telemetry/schema"
import { Button } from "@/components/ui/button"

interface Props {
  initialMode: TelemetryMode
}

/**
 * Telemetry consent toggle for the settings page. Shows the current mode and
 * lets the superuser switch between `community` (anonymous aggregate telemetry)
 * and `off` (nothing transmitted). The action enforces the superuser gate.
 */
export function TelemetryForm({ initialMode }: Props) {
  const t = useTranslations("telemetry")
  const router = useRouter()
  const [mode, setModeState] = useState<TelemetryMode>(initialMode)
  const [pending, setPending] = useState<TelemetryMode | null>(null)

  async function choose(next: TelemetryMode) {
    if (next === mode || pending) return
    setPending(next)
    const work = (async () => {
      const result = await setTelemetryMode({ mode: next })
      if (!result.result) throw new Error(result.message ?? t("settings.error"))
      setModeState(next)
      router.refresh()
    })()

    toast.promise(work, {
      loading: t("settings.saving"),
      success: next === "community" ? t("banner.optedIn") : t("banner.optedOut"),
      error: (err: Error) => err.message ?? t("settings.error"),
    })

    try {
      await work
    } catch {
      // surfaced by toast.promise
    } finally {
      setPending(null)
    }
  }

  const busy = pending !== null
  const options: TelemetryMode[] = ["community", "off"]

  return (
    <div className="space-y-3">
      <div
        role="radiogroup"
        aria-label={t("settings.title")}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {options.map((opt) => {
          const selected = mode === opt
          return (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => choose(opt)}
              className={`flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors disabled:opacity-60 ${
                selected
                  ? "border-foreground bg-accent"
                  : "border-border hover:border-foreground/40"
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {pending === opt && <Loader2Icon className="h-3.5 w-3.5 animate-spin" />}
                {t(`mode.${opt}.label`)}
                {selected && (
                  <span className="rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-medium text-background">
                    {t("settings.current")}
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{t(`mode.${opt}.description`)}</span>
            </button>
          )
        })}
      </div>

      <p className="text-xs text-muted-foreground">{t("settings.hint")}</p>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        render={<Link href="/settings/telemetry/data" />}
        className="px-0 text-xs text-muted-foreground hover:text-foreground"
      >
        {t("banner.whatLink")}
      </Button>
    </div>
  )
}
