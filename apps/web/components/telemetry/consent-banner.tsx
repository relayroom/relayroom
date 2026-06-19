"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2Icon, BarChart3Icon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { setTelemetryMode } from "@/modules/telemetry/actions"
import type { TelemetryMode } from "@/modules/telemetry/schema"
import { Button } from "@/components/ui/button"

/**
 * Telemetry banner. Rendered only for the instance superuser until they make an
 * explicit choice. The default before then is `anonymous` (content-free, no install
 * id) - so this is an informed upgrade/opt-out, not a precondition for any data:
 * share more (community), keep anonymous, or turn it off. Any choice dismisses it.
 */
export function TelemetryConsentBanner() {
  const t = useTranslations("telemetry")
  const router = useRouter()
  const [dismissed, setDismissed] = useState(false)
  const [pending, setPending] = useState<TelemetryMode | null>(null)

  if (dismissed) return null

  async function choose(mode: TelemetryMode) {
    setPending(mode)
    const work = (async () => {
      const result = await setTelemetryMode({ mode })
      if (!result.result) throw new Error(result.message ?? t("banner.error"))
      setDismissed(true)
      router.refresh()
    })()

    toast.promise(work, {
      loading: t("banner.saving"),
      success: mode === "community" ? t("banner.optedIn") : t("banner.optedOut"),
      error: (err: Error) => err.message ?? t("banner.error"),
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

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4 sm:flex sm:items-center sm:gap-4">
      <div className="flex flex-1 items-start gap-3">
        <div className="mt-0.5 hidden shrink-0 rounded-md bg-background p-2 sm:block">
          <BarChart3Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("banner.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t("banner.body")}{" "}
            <Link
              href="/settings/telemetry/data"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {t("banner.whatLink")}
            </Link>
          </p>
        </div>
      </div>

      <div className="mt-3 flex shrink-0 items-center gap-2 sm:mt-0">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => choose("off")}
        >
          {pending === "off" && <Loader2Icon className="mr-2 h-3.5 w-3.5 animate-spin" />}
          {t("banner.declineButton")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => choose("anonymous")}
        >
          {pending === "anonymous" && <Loader2Icon className="mr-2 h-3.5 w-3.5 animate-spin" />}
          {t("banner.keepButton")}
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => choose("community")}>
          {pending === "community" && <Loader2Icon className="mr-2 h-3.5 w-3.5 animate-spin" />}
          {t("banner.acceptButton")}
        </Button>
        <button
          type="button"
          aria-label={t("banner.dismiss")}
          disabled={busy}
          onClick={() => setDismissed(true)}
          className="ml-1 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
