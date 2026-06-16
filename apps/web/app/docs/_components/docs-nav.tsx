"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { DOCS_ENTRIES, DOCS_SECTIONS, type DocsLocale } from "../_content/registry";

export function DocsNav({ locale }: { locale: DocsLocale }) {
  const pathname = usePathname();
  const base = `/docs/${locale}`;

  return (
    <nav aria-label="Docs navigation" className="space-y-6">
      {DOCS_SECTIONS.map((section) => {
        const entries = DOCS_ENTRIES.filter((e) => e.section === section.key);
        if (entries.length === 0) return null;
        return (
          <div key={section.key}>
            <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
              {section.label[locale]}
            </p>
            <ul className="space-y-0.5">
              {entries.map((entry) => {
                const href = entry.slug ? `${base}/${entry.slug}` : base;
                const isActive =
                  entry.slug === "" ? pathname === base : pathname === href;
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      className={cn(
                        "block rounded-md px-3 py-1.5 text-sm transition-colors",
                        isActive
                          ? "bg-primary text-primary-foreground font-medium"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {entry.label[locale]}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
