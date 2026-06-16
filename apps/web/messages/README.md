# i18n Messages Convention

## Overview

next-intl is configured WITHOUT `[locale]` URL segments (no route restructuring).
Locale is stored in a `NEXT_LOCALE` cookie (default: `"ko"`).
Supported locales: `["ko", "en"]`.

## File Layout

```
messages/
  ko/
    common.json      <- shared keys: actions, nav labels, topbar, sidebar
    settings.json    <- /my/settings page
    <namespace>.json <- add new files freely
  en/
    common.json
    settings.json
    <namespace>.json
```

**One JSON file per (locale, namespace). Namespace = feature area.**
This ensures multiple agents never edit the same file concurrently.

## How getRequestConfig Merges Namespaces

`i18n/request.ts` reads the `NEXT_LOCALE` cookie, then uses `fs.readdirSync`
to find every `*.json` in `messages/<locale>/`. Each file becomes a top-level
key in the messages object named after its filename (minus `.json`).

Result: `{ common: { ... }, settings: { ... }, <ns>: { ... } }`

Adding a new namespace means dropping a new JSON file - no code changes needed.

## How to Add a New Namespace

1. Create `messages/ko/<namespace>.json` with Korean copy.
2. Create `messages/en/<namespace>.json` with English translations.
3. Use `getTranslations("<namespace>")` (server) or `useTranslations("<namespace>")` (client).

No changes to `i18n/request.ts` are needed.

## Usage Patterns

### Server components (async, e.g. page.tsx with `export const dynamic = "force-dynamic"`)

```tsx
import { getTranslations } from "next-intl/server"

export default async function MyPage() {
  const t = await getTranslations("settings")
  return <h1>{t("pageTitle")}</h1>
}
```

### Client components (`"use client"`)

```tsx
"use client"
import { useTranslations } from "next-intl"

export function MyComponent() {
  const t = useTranslations("common")
  return <button>{t("actions.save")}</button>
}
```

### Nested namespace shorthand

Both patterns support dot-notation for the namespace path:

```tsx
const t = useTranslations("common.topbar")
t("searchPlaceholder") // reads common.topbar.searchPlaceholder
```

Or read the whole namespace and use dot paths on keys:

```tsx
const t = useTranslations("common")
t("topbar.searchPlaceholder")
```

## Key Naming Convention

- Use camelCase for all keys.
- Group logically within the namespace (e.g. `actions.save`, `nav.dashboard`).
- No dots in key names themselves - use object nesting instead.
- `ko/*.json` values are the EXISTING Korean copy verbatim.
- `en/*.json` values are accurate English translations of the Korean.

## setLocale Server Action

Location: `app/actions/locale.ts`

Exported: `setLocale(locale: "ko" | "en"): Promise<void>`

Sets the `NEXT_LOCALE` cookie and calls `revalidatePath("/", "layout")`.
Client components should call `router.refresh()` after `await setLocale(...)`.

## Files Owned by This Setup (do not restructure)

| File | Owner |
|------|-------|
| `i18n/request.ts` | i18n foundation |
| `next.config.ts` | i18n foundation (wraps with withNextIntl) |
| `app/layout.tsx` | i18n foundation (NextIntlClientProvider) |
| `app/actions/locale.ts` | i18n foundation (setLocale action) |
| `components/language-switcher.tsx` | i18n foundation |
| `messages/ko/common.json` | common namespace |
| `messages/en/common.json` | common namespace |
| `messages/ko/settings.json` | settings namespace |
| `messages/en/settings.json` | settings namespace |
| `components/layouts/app/sidebar.tsx` | migrated - uses common |
| `components/layouts/app/topbar.tsx` | migrated - uses common |
| `app/(dashboard)/my/settings/page.tsx` | migrated - uses settings |

## Existing Namespaces

| Namespace | Files | Used by |
|-----------|-------|---------|
| `common` | `ko/common.json`, `en/common.json` | sidebar, topbar, any shared UI |
| `settings` | `ko/settings.json`, `en/settings.json` | `/my/settings` page |
