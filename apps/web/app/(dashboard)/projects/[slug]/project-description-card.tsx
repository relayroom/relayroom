"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Markdown } from "@/components/markdown"

// Collapsed height cap (px). ~16rem ≈ 12-14 lines: a meaningful chunk without
// letting a long description dominate the overview. Past it, the body scrolls and
// an expand toggle removes the cap to show everything at once.
const COLLAPSED_MAX_PX = 256

export function ProjectDescriptionCard({ content }: { content: string }) {
  const t = useTranslations("project")
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Only show the toggle when the content actually exceeds the cap. scrollHeight is
  // the full content height regardless of the applied maxHeight, so this stays
  // correct in both states. Re-measure on width changes (reflow shifts the height).
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > COLLAPSED_MAX_PX + 4)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [content])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("overview.aboutLabel")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          ref={bodyRef}
          className="overflow-y-auto"
          style={{ maxHeight: expanded ? undefined : COLLAPSED_MAX_PX }}
        >
          <Markdown content={content} />
        </div>
        {overflows && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? (
              <>
                <ChevronUpIcon className="h-3.5 w-3.5" />
                {t("overview.collapse")}
              </>
            ) : (
              <>
                <ChevronDownIcon className="h-3.5 w-3.5" />
                {t("overview.expand")}
              </>
            )}
          </button>
        )}
      </CardContent>
    </Card>
  )
}
