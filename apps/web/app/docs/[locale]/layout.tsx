import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { SiteNav } from "@/components/nav/site-nav";
import { DocsNav } from "../_components/docs-nav";
import { DocsCommandPalette } from "../_components/docs-command-palette";
import { DocsSearchTrigger } from "../_components/docs-search-trigger";
import { DOCS_ENTRIES, DOCS_SECTIONS, isDocsLocale } from "../_content/registry";

/**
 * Public docs shell — outside (dashboard), no auth guard.
 * Locale-aware: header has a KO/EN switch, sidebar nav prefixes the locale.
 * Left sidebar + prose content area.
 */
export default async function DocsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isDocsLocale(locale)) notFound();

  // Lightweight, MDX-free search index for the ⌘K palette (plain data only).
  const searchEntries = DOCS_ENTRIES.map((e) => ({
    slug: e.slug,
    section: e.section,
    label: e.label[locale],
  }));
  const searchSections = DOCS_SECTIONS.map((s) => ({ key: s.key, label: s.label[locale] }));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteNav locale={locale} surface="docs" />

      <DocsCommandPalette locale={locale} entries={searchEntries} sections={searchSections} />

      {/* Body: sidebar + content */}
      <div className="mx-auto flex w-full max-w-screen-xl flex-1 px-4 sm:px-6">
        {/* Left sidebar */}
        <aside className="hidden w-56 shrink-0 py-8 pr-8 md:block">
          <div className="mb-4">
            <DocsSearchTrigger locale={locale} />
          </div>
          <DocsNav locale={locale} />
        </aside>

        {/* Prose content */}
        <main className="min-w-0 flex-1 py-8">
          <article
            className="prose prose-slate dark:prose-invert max-w-3xl
              prose-headings:font-semibold prose-headings:tracking-tight
              prose-a:text-primary prose-a:no-underline hover:prose-a:underline
              prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
              prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border
              prose-pre:rounded-lg prose-pre:font-mono"
          >
            {children}
          </article>
        </main>
      </div>
    </div>
  );
}
