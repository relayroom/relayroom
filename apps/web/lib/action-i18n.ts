import fs from "node:fs"
import path from "node:path"
import { createTranslator } from "next-intl"
import { getTranslations } from "next-intl/server"
import { DEFAULT_LOCALE } from "@/i18n/request"

/**
 * Server-side translator for one message namespace, usable from a Server Action,
 * a Route Handler, or a better-auth callback.
 *
 * In production these all run inside a request scope, so `getTranslations(ns)`
 * resolves the caller's locale from the NEXT_LOCALE cookie. Unit tests, however,
 * invoke actions DIRECTLY with no request scope - there `getTranslations` (which
 * reads cookies()) throws. We catch that and fall back to a default-locale (en)
 * translator built straight from the JSON file, so callers stay fully localized
 * in production while remaining callable in tests.
 *
 * The returned value is a plain `t(key, values?)` function in both paths.
 */
export type Translator = (key: string, values?: Record<string, string | number>) => string

/** @deprecated name kept for the existing `errors` call sites; same shape. */
export type ErrorTranslator = Translator

const fallbackTranslators = new Map<string, Translator>()

function loadFallbackTranslator(namespace: string): Translator {
  const cached = fallbackTranslators.get(namespace)
  if (cached) return cached
  const file = path.join(process.cwd(), "messages", DEFAULT_LOCALE, `${namespace}.json`)
  const messages = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>
  // createTranslator infers a literal key union from the messages object; we want
  // a plain string-keyed translator here, so widen the call signature.
  const t = createTranslator({
    locale: DEFAULT_LOCALE,
    namespace,
    messages: { [namespace]: messages },
  }) as unknown as Translator
  const translator: Translator = (key, values) => t(key, values)
  fallbackTranslators.set(namespace, translator)
  return translator
}

/** Translator for any namespace (one JSON file under messages/<locale>/). */
export async function getNamespaceTranslations(namespace: string): Promise<Translator> {
  try {
    const t = await getTranslations(namespace)
    return (key, values) => t(key, values)
  } catch {
    // No request scope (e.g. a unit test calling the action directly) - serve the
    // default-locale copy so the caller still produces meaningful text.
    return loadFallbackTranslator(namespace)
  }
}

/** The `errors` namespace - by far the most common case. */
export async function getErrorTranslations(): Promise<Translator> {
  return getNamespaceTranslations("errors")
}
