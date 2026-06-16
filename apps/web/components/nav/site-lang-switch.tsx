"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type Locale = "en" | "ko";

/** Persist the chosen language so it carries across landing / docs / app. */
function setLocaleCookie(l: Locale) {
  try {
    document.cookie = `NEXT_LOCALE=${l}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* ignore */
  }
}

/**
 * Shared EN|KO segmented switch. On docs it swaps the locale segment of the
 * current path (preserving the page); on the landing it points at / and /ko.
 * Either way it writes the NEXT_LOCALE cookie.
 */
export function SiteLangSwitch({
  locale,
  surface,
}: {
  locale: Locale;
  surface: "landing" | "docs";
}) {
  const pathname = usePathname();
  const hrefFor = (l: Locale) => {
    if (surface === "docs") {
      const rest = pathname.replace(/^\/docs\/[^/]+/, "");
      return `/docs/${l}${rest}`;
    }
    return l === "ko" ? "/ko" : "/";
  };

  return (
    <div className="flex items-center rounded-md border border-border p-0.5 text-xs font-medium">
      {(["en", "ko"] as const).map((l) => (
        <Link
          key={l}
          href={hrefFor(l)}
          onClick={() => setLocaleCookie(l)}
          aria-current={l === locale ? "true" : undefined}
          className={cn(
            "rounded px-2 py-1 transition-colors",
            l === locale
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {l.toUpperCase()}
        </Link>
      ))}
    </div>
  );
}
