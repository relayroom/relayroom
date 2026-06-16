import { cookies } from "next/headers"
import { getRequestConfig } from "next-intl/server"
import fs from "fs"
import path from "path"
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type SupportedLocale } from "./locales"

// Re-export the client-safe locale constants so existing
// `from "@/i18n/request"` importers keep working.
export { SUPPORTED_LOCALES, DEFAULT_LOCALE, type SupportedLocale }

/**
 * Reads all JSON files under messages/<locale>/ and merges them into a single
 * messages object keyed by namespace (filename without extension).
 *
 * Example: messages/ko/common.json -> { common: { ... } }
 *          messages/ko/settings.json -> { settings: { ... } }
 * Result:  { common: { ... }, settings: { ... } }
 *
 * This means adding a new namespace is as simple as dropping a new JSON file.
 */
function loadMessages(locale: string): Record<string, unknown> {
  const messagesDir = path.join(process.cwd(), "messages", locale)

  if (!fs.existsSync(messagesDir)) {
    return {}
  }

  const files = fs.readdirSync(messagesDir).filter((f) => f.endsWith(".json"))

  const merged: Record<string, unknown> = {}
  for (const file of files) {
    const namespace = file.replace(/\.json$/, "")
    const content = fs.readFileSync(path.join(messagesDir, file), "utf-8")
    merged[namespace] = JSON.parse(content)
  }

  return merged
}

export default getRequestConfig(async () => {
  const store = await cookies()
  const raw = store.get("NEXT_LOCALE")?.value ?? DEFAULT_LOCALE
  const locale = (SUPPORTED_LOCALES as readonly string[]).includes(raw)
    ? (raw as SupportedLocale)
    : DEFAULT_LOCALE

  const messages = loadMessages(locale)

  return {
    locale,
    messages,
  }
})

/**
 * Helper for server components that need the current locale without going
 * through getMessages(). Reads the same cookie logic as above.
 */
export async function getCurrentLocale(): Promise<SupportedLocale> {
  const store = await cookies()
  const raw = store.get("NEXT_LOCALE")?.value ?? DEFAULT_LOCALE
  return (SUPPORTED_LOCALES as readonly string[]).includes(raw)
    ? (raw as SupportedLocale)
    : DEFAULT_LOCALE
}
