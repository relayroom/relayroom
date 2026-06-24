"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Textarea } from "@/components/ui/textarea"
import { Markdown } from "@/components/markdown"
import { cn } from "@/lib/utils"

interface MarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  rows?: number
  placeholder?: string
}

const TABS = ["write", "preview"] as const
type Tab = (typeof TABS)[number]

// 작성/미리보기를 좌우 분할 대신 탭으로 전환한다. 분할은 작성칸이 절반으로
// 좁아져 답답했어서, 탭이면 활성 탭이 전체 폭을 쓴다.
export function MarkdownEditor({
  value,
  onChange,
  disabled = false,
  rows = 6,
  placeholder,
}: MarkdownEditorProps) {
  const t = useTranslations("ui")
  const [tab, setTab] = useState<Tab>("write")
  const minHeight = `${rows * 1.5}rem`
  const resolvedPlaceholder = placeholder ?? t("markdownEditor.defaultPlaceholder")

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1 border-b border-border">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
              tab === key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`markdownEditor.${key}`)}
          </button>
        ))}
      </div>

      {tab === "write" ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={rows}
          placeholder={resolvedPlaceholder}
          className="resize-y font-mono text-sm"
          style={{ minHeight }}
        />
      ) : (
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
      )}

      <p className="text-xs text-muted-foreground">{t("markdownEditor.supportsMarkdown")}</p>
    </div>
  )
}
