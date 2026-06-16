"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { setLocale } from "@/app/actions/locale"

/**
 * Inline locale switcher for the entry (sign-in) page: "English (current) | 한국어".
 * The active locale (server-decided via the NEXT_LOCALE cookie + request config,
 * surfaced through useLocale) is marked with t("current") — which itself renders
 * in the active language ("(current)" / "(현재)"). Language labels stay in their
 * own language, as is conventional for a language picker.
 */
export function LoginLocaleSwitcher() {
  const locale = useLocale()
  const t = useTranslations("common.localeSwitcher")
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function switchTo(next: string) {
    if (next === locale) return
    startTransition(async () => {
      await setLocale(next)
      router.refresh()
    })
  }

  function item(code: string, label: string) {
    if (locale === code) {
      return (
        <span className="font-medium text-foreground">
          {label} {t("current")}
        </span>
      )
    }
    return (
      <button
        type="button"
        onClick={() => switchTo(code)}
        disabled={isPending}
        className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        {label}
      </button>
    )
  }

  return (
    <div className="mt-6 flex items-center justify-center gap-3 text-xs">
      {item("en", "English")}
      <span className="text-border">|</span>
      {item("ko", "한국어")}
    </div>
  )
}
