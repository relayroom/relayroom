"use client"

import { CrownIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

/**
 * The single, consistent indicator for a project's main agent. Use this
 * everywhere a main agent is shown (lists, detail, event cards) so the marking is
 * identical across the app.
 */
export function MainAgentBadge({ className }: { className?: string }) {
  const t = useTranslations("common")
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
        className,
      )}
    >
      <CrownIcon className="h-3 w-3" />
      {t("mainAgent")}
    </span>
  )
}
