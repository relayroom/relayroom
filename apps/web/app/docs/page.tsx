import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEFAULT_DOCS_LOCALE, isDocsLocale } from "./_content/registry";

/**
 * Bare `/docs` has no content of its own. Redirect to a locale index.
 * Default is `/docs/en`; if the visitor already chose Korean app-wide
 * (NEXT_LOCALE cookie), honor it and send them to `/docs/ko`.
 */
export default async function DocsIndex() {
  const cookieLocale = (await cookies()).get("NEXT_LOCALE")?.value ?? "";
  const locale = isDocsLocale(cookieLocale) ? cookieLocale : DEFAULT_DOCS_LOCALE;
  redirect(`/docs/${locale}`);
}
