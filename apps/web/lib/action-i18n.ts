import fs from "node:fs"
import path from "node:path"
import { createTranslator } from "next-intl"
import { getTranslations } from "next-intl/server"
import { DEFAULT_LOCALE } from "@/i18n/request"

/**
 * Translator for the `errors` namespace, usable from any Server Action.
 *
 * In production every Server Action runs inside a request scope, so
 * `getTranslations("errors")` resolves the caller's locale from the NEXT_LOCALE
 * cookie. Unit tests, however, invoke actions DIRECTLY with no request scope -
 * there `getTranslations` (which reads cookies()) throws. We catch that and fall
 * back to a default-locale (en) translator built straight from the JSON file, so
 * actions stay fully localized in production while remaining callable in tests.
 *
 * The returned value is a plain `t(key, values?)` function in both paths.
 */
export type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string

let fallbackTranslator: ErrorTranslator | null = null

function loadFallbackTranslator(): ErrorTranslator {
  if (fallbackTranslator) return fallbackTranslator
  const file = path.join(process.cwd(), "messages", DEFAULT_LOCALE, "errors.json")
  const messages = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>
  // createTranslator infers a literal key union from the messages object; we want
  // a plain string-keyed translator here, so widen the call signature.
  const t = createTranslator({
    locale: DEFAULT_LOCALE,
    namespace: "errors",
    messages: { errors: messages },
  }) as unknown as ErrorTranslator
  fallbackTranslator = (key, values) => t(key, values)
  return fallbackTranslator
}

export async function getErrorTranslations(): Promise<ErrorTranslator> {
  try {
    const t = await getTranslations("errors")
    return (key, values) => t(key, values)
  } catch {
    // No request scope (e.g. a unit test calling the action directly) - serve the
    // default-locale copy so the action still returns a meaningful message.
    return loadFallbackTranslator()
  }
}
