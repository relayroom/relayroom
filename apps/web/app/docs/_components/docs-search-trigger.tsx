"use client";

import { SearchIcon } from "lucide-react";
import { OPEN_DOCS_SEARCH } from "./docs-command-palette";

const LABEL = { en: "Search docs", ko: "문서 검색" } as const;

/** Sidebar button that opens the docs ⌘K search palette. */
export function DocsSearchTrigger({ locale }: { locale: "en" | "ko" }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_DOCS_SEARCH))}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <SearchIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 text-left">{LABEL[locale] ?? LABEL.en}</span>
      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
    </button>
  );
}
