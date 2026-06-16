/**
 * Client-safe locale constants. Kept free of any server-only imports (no
 * next/headers, no fs) so both client components (the language switcher) and
 * server code can import from here. `i18n/request.ts` re-exports these for
 * backward compatibility.
 *
 * Adding a language: append its code here, add its native name below, and drop
 * a messages/<code>/ folder. No component changes needed.
 */
export const SUPPORTED_LOCALES = ["ko", "en"] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: SupportedLocale = "en"

/**
 * Each language labelled in its own script (endonym), the convention for
 * language pickers so a speaker always recognizes their language.
 */
export const LOCALE_NATIVE_NAMES: Record<SupportedLocale, string> = {
  ko: "한국어",
  en: "English",
}
