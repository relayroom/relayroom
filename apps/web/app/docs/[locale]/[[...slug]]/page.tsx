import { notFound } from "next/navigation";
import {
  DOCS_ENTRIES,
  DOCS_LOCALES,
  findDocsEntry,
  isDocsLocale,
} from "../../_content/registry";

/** Pre-render every locale × page combination at build time. */
export function generateStaticParams() {
  return DOCS_LOCALES.flatMap((locale) =>
    DOCS_ENTRIES.map((entry) => ({
      locale,
      slug: entry.slug ? entry.slug.split("/") : [],
    })),
  );
}

interface DocsPageProps {
  params: Promise<{ locale: string; slug?: string[] }>;
}

export default async function DocsPage({ params }: DocsPageProps) {
  const { locale, slug } = await params;
  if (!isDocsLocale(locale)) notFound();

  const key = (slug ?? []).join("/");
  const entry = findDocsEntry(key);
  if (!entry) notFound();

  const Content = entry.content[locale];
  return <Content />;
}
