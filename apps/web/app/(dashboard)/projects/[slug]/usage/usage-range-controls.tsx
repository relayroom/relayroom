"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

interface Props {
  from: string
  to: string
  /** Earliest day with usage, for the "All" preset. */
  firstDay: string | null
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

export function UsageRangeControls({ from, to, firstDay }: Props) {
  const t = useTranslations("project.usageDetail")
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const today = new Date().toISOString().slice(0, 10)

  function apply(nextFrom: string, nextTo: string) {
    const sp = new URLSearchParams(params.toString())
    sp.set("from", nextFrom)
    sp.set("to", nextTo)
    router.replace(`${pathname}?${sp.toString()}`)
  }

  const presets: { key: string; days: number }[] = [
    { key: "last14", days: 14 },
    { key: "last30", days: 30 },
    { key: "last90", days: 90 },
  ]
  const activePreset = presets.find((p) => from === isoDaysAgo(p.days - 1) && to === today)
  const allActive = !!firstDay && from === firstDay && to === today

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="inline-flex h-8 items-center gap-0.5 rounded-md border border-border p-0.5">
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => apply(isoDaysAgo(p.days - 1), today)}
            className={cn(
              "inline-flex h-full cursor-pointer items-center rounded px-2.5 text-xs font-medium transition-colors",
              activePreset?.key === p.key
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(p.key)}
          </button>
        ))}
        <button
          type="button"
          disabled={!firstDay}
          onClick={() => firstDay && apply(firstDay, today)}
          className={cn(
            "inline-flex h-full cursor-pointer items-center rounded px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            allActive
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("all")}
        </button>
      </div>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => e.target.value && apply(e.target.value, to)}
          className="h-8 cursor-pointer rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={t("from")}
        />
        <span>-</span>
        <input
          type="date"
          value={to}
          min={from}
          max={today}
          onChange={(e) => e.target.value && apply(from, e.target.value)}
          className="h-8 cursor-pointer rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={t("to")}
        />
      </div>
    </div>
  )
}
