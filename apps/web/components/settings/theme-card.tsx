"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "@wrksz/themes/client"
import { CheckIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type ThemeOption = "light" | "dark" | "system"

const THEME_OPTIONS: { value: ThemeOption; labelKey: string; descKey: string }[] = [
  { value: "system", labelKey: "system", descKey: "systemDesc" },
  { value: "light", labelKey: "light", descKey: "lightDesc" },
  { value: "dark", labelKey: "dark", descKey: "darkDesc" },
]

/**
 * A small skeleton mockup of the app shell (sidebar + topbar + content blocks)
 * rendered with hardcoded light/dark palettes so the preview always reflects the
 * target theme regardless of the currently active one.
 */
function ThemePreview({ variant }: { variant: "light" | "dark" }) {
  const light = variant === "light"
  const surface = light ? "bg-white" : "bg-zinc-900"
  const border = light ? "border-zinc-200" : "border-zinc-700"
  const sidebar = light ? "bg-zinc-100" : "bg-zinc-800"
  const bar = light ? "bg-zinc-200" : "bg-zinc-700"
  const barSoft = light ? "bg-zinc-200/70" : "bg-zinc-700/70"
  const accent = light ? "bg-zinc-800" : "bg-zinc-300"

  return (
    <div className={cn("flex h-20 w-full max-w-xs overflow-hidden rounded-md border", border, surface)}>
      {/* Sidebar */}
      <div className={cn("flex w-1/4 flex-col gap-1.5 p-2", sidebar)}>
        <div className={cn("h-1.5 w-3/4 rounded-full", accent)} />
        <div className={cn("h-1.5 w-full rounded-full", bar)} />
        <div className={cn("h-1.5 w-full rounded-full", bar)} />
        <div className={cn("h-1.5 w-2/3 rounded-full", barSoft)} />
      </div>
      {/* Main */}
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        {/* Topbar */}
        <div className="flex items-center justify-between">
          <div className={cn("h-2 w-1/3 rounded-full", accent)} />
          <div className={cn("h-2 w-2 rounded-full", bar)} />
        </div>
        <div className={cn("mt-0.5 h-1.5 w-full rounded-full", bar)} />
        <div className={cn("h-1.5 w-5/6 rounded-full", barSoft)} />
        <div className={cn("h-1.5 w-3/4 rounded-full", barSoft)} />
      </div>
    </div>
  )
}

export function ThemeCard() {
  const t = useTranslations("ui")
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Avoid hydration mismatch
  const currentTheme: ThemeOption = mounted ? ((theme ?? "system") as ThemeOption) : "system"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("themeSettings.title")}</CardTitle>
        <CardDescription>{t("themeSettings.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {THEME_OPTIONS.map(({ value, labelKey, descKey }) => {
            const selected = mounted && currentTheme === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                disabled={!mounted}
                className={cn(
                  "flex flex-col gap-3 rounded-lg border p-4 text-left transition-all sm:flex-row sm:items-start sm:gap-4",
                  selected
                    ? "border-foreground bg-accent/40"
                    : "border-border hover:border-foreground/30",
                )}
              >
                {/* Left: selection indicator + name */}
                <div className="flex shrink-0 items-center gap-1.5 pt-0.5 sm:w-24">
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border",
                      selected ? "border-foreground bg-foreground text-background" : "border-muted-foreground/40",
                    )}
                  >
                    {selected && <CheckIcon className="h-3 w-3" />}
                  </span>
                  <span className={cn("text-sm font-medium", selected ? "text-foreground" : "text-foreground/80")}>
                    {t(`themeSettings.${labelKey}`)}
                  </span>
                </div>

                {/* Right: skeleton preview (light/dark) + description */}
                <div className="min-w-0 flex-1 space-y-2">
                  {value !== "system" && <ThemePreview variant={value} />}
                  <p className="text-xs text-muted-foreground">{t(`themeSettings.${descKey}`)}</p>
                </div>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
