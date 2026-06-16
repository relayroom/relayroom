"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DocsSearchEntry {
  slug: string;
  section: string;
  label: string;
}
export interface DocsSearchSection {
  key: string;
  label: string;
}

const STRINGS = {
  en: { placeholder: "Search docs…", empty: "No results" },
  ko: { placeholder: "문서 검색…", empty: "검색 결과가 없습니다" },
} as const;

/** Window event the sidebar search button dispatches to open the palette. */
export const OPEN_DOCS_SEARCH = "open-docs-search";

/**
 * ⌘K page-search palette for the docs site - jumps to any docs page by title.
 * Self-contained (no cmdk; that library crashes in this React 19 / base-ui
 * stack), opened by ⌘K or the sidebar search button.
 */
export function DocsCommandPalette({
  locale,
  entries,
  sections,
}: {
  locale: "en" | "ko";
  entries: DocsSearchEntry[];
  sections: DocsSearchSection[];
}) {
  const router = useRouter();
  const s = STRINGS[locale] ?? STRINGS.en;
  const base = `/docs/${locale}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const hrefOf = (slug: string) => (slug ? `${base}/${slug}` : base);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => `${e.label} ${e.slug}`.toLowerCase().includes(q))
    : entries;

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery("");
    setHighlighted(0);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const go = useCallback(
    (slug: string) => {
      setOpen(false);
      router.push(hrefOf(slug));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, base],
  );

  // ⌘K toggles; the sidebar button dispatches OPEN_DOCS_SEARCH.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpen() {
      openPalette();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_DOCS_SEARCH, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_DOCS_SEARCH, onOpen);
    };
  }, [openPalette]);

  useEffect(() => {
    if (open) {
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);
  useEffect(() => setHighlighted(0), [query]);

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((p) => (filtered.length ? (p + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((p) => (filtered.length ? (p - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[highlighted];
      if (target) go(target.slug);
    }
  }

  if (!open) return null;

  let abs = 0;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={s.placeholder}
      className="fixed inset-0 z-[80] flex flex-col items-center"
      onClick={close}
    >
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />
      <div
        className="relative mx-auto mt-24 w-full max-w-xl overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={s.placeholder}
            aria-label={s.placeholder}
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            ESC
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">{s.empty}</div>
          ) : (
            sections.map((sec) => {
              const items = filtered.filter((e) => e.section === sec.key);
              if (items.length === 0) return null;
              return (
                <div key={sec.key}>
                  <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {sec.label}
                  </div>
                  {items.map((entry) => {
                    const idx = abs++;
                    const isHighlighted = highlighted === idx;
                    return (
                      <button
                        key={entry.slug || "index"}
                        type="button"
                        onMouseEnter={() => setHighlighted(idx)}
                        onClick={() => go(entry.slug)}
                        className={cn(
                          "flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 text-sm transition-colors",
                          isHighlighted
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        <span className="truncate text-left">{entry.label}</span>
                        <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">
                          {hrefOf(entry.slug)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
