"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { useLocale } from "next-intl"
import { setLocale } from "@/app/actions/locale"
import { SUPPORTED_LOCALES, LOCALE_NATIVE_NAMES, type SupportedLocale } from "@/i18n/locales"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function LanguageSwitcher() {
  const locale = useLocale()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function handleSwitch(next: string | null) {
    if (!next || next === locale) return
    startTransition(async () => {
      await setLocale(next)
      router.refresh()
    })
  }

  return (
    <Select value={locale} onValueChange={handleSwitch} disabled={isPending}>
      <SelectTrigger className="w-full max-w-xs">
        <SelectValue>
          {(value) => LOCALE_NATIVE_NAMES[(value as SupportedLocale) ?? "en"] ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {SUPPORTED_LOCALES.map((code) => (
          <SelectItem key={code} value={code}>
            {LOCALE_NATIVE_NAMES[code]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
