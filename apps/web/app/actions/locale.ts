"use server"

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { SUPPORTED_LOCALES, type SupportedLocale } from "@/i18n/request"

/**
 * Server action: sets the NEXT_LOCALE cookie and revalidates the full layout
 * so the new locale takes effect immediately on the next render.
 *
 * Usage from a client component:
 *   import { setLocale } from "@/app/actions/locale"
 *   await setLocale("en")
 *   router.refresh()
 */
export async function setLocale(locale: string): Promise<void> {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    throw new Error(`Unsupported locale: ${locale}`)
  }

  const store = await cookies()
  store.set("NEXT_LOCALE", locale as SupportedLocale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "lax",
  })

  revalidatePath("/", "layout")
}
