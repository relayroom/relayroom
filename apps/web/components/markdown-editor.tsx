"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Textarea } from "@/components/ui/textarea"
import { Markdown } from "@/components/markdown"

interface MarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  rows?: number
  placeholder?: string
}

// sm(640px) 이상이면 작성/미리보기 좌우 분할, 미만이면 textarea만.
const PREVIEW_QUERY = "(min-width: 640px)"

function useMediaQuery(query: string): boolean {
  // SSR/최초 렌더는 false로 시작해 textarea만 그린 뒤,
  // 마운트 후 실제 매치 결과로 갱신한다 (hydration mismatch 방지).
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia(query)
    setMatches(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])
  return matches
}

export function MarkdownEditor({
  value,
  onChange,
  disabled = false,
  rows = 6,
  placeholder,
}: MarkdownEditorProps) {
  const t = useTranslations("ui")
  const showPreview = useMediaQuery(PREVIEW_QUERY)
  const minHeight = `${rows * 1.5}rem`
  const resolvedPlaceholder = placeholder ?? t("markdownEditor.defaultPlaceholder")

  const editor = (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      rows={rows}
      placeholder={resolvedPlaceholder}
      className="resize-y font-mono text-sm"
      style={{ minHeight }}
    />
  )

  const preview = (
    <div
      className="overflow-auto rounded-md border border-border bg-background px-3 py-2"
      style={{ minHeight }}
    >
      {value.trim() ? (
        <Markdown content={value} />
      ) : (
        <p className="text-xs text-muted-foreground">{t("markdownEditor.previewEmpty")}</p>
      )}
    </div>
  )

  return (
    <div className="space-y-1.5">
      {showPreview ? (
        // sm 이상: 좌 작성 / 우 미리보기 (라이브 프리뷰)
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("markdownEditor.write")}</span>
            {editor}
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("markdownEditor.preview")}</span>
            {preview}
          </div>
        </div>
      ) : (
        // sm 미만: textarea만
        editor
      )}

      <p className="text-xs text-muted-foreground">{t("markdownEditor.supportsMarkdown")}</p>
    </div>
  )
}
