import Link from "next/link";
import { RelayRoomMark } from "@/components/brand/relayroom-mark";
import { cn } from "@/lib/utils";
import { SiteLangSwitch } from "./site-lang-switch";
import { SiteNavAuth } from "./site-nav-auth";
import { ThemeToggle } from "./theme-toggle";

const GITHUB_URL = "https://github.com/relayroom/relayroom";

const GithubIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.25.82-.56 0-.27-.01-1-.02-1.96-3.34.72-4.04-1.6-4.04-1.6-.55-1.38-1.34-1.75-1.34-1.75-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.22 1.84 1.22 1.07 1.8 2.81 1.28 3.5.98.11-.76.42-1.28.76-1.57-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.21a11.6 11.6 0 0 1 6 0c2.29-1.53 3.3-1.21 3.3-1.21.65 1.66.24 2.88.12 3.18.77.83 1.23 1.88 1.23 3.17 0 4.54-2.81 5.54-5.49 5.83.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .31.21.68.83.56A12.01 12.01 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z" />
  </svg>
);

/**
 * The site-wide top nav, shared by the marketing landing and the docs.
 * Layout: brand (left) · Docs (centered) · controls (right).
 * Mostly server-rendered for SEO - only the language switch and theme toggle
 * are client islands. App tokens (text-foreground / border-border / …) make it
 * adapt to light/dark in both contexts.
 */
export function SiteNav({
  locale,
  surface,
}: {
  locale: "en" | "ko";
  surface: "landing" | "docs";
}) {
  const landingHome = locale === "ko" ? "/ko" : "/";
  const docsHome = `/docs/${locale}`;
  const docsLabel = locale === "ko" ? "문서" : "Docs";

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-sm">
      <div className="relative mx-auto flex h-14 max-w-screen-xl items-center justify-between px-4 sm:px-6">
        {/* left: brand → landing home (locale-aware) */}
        <Link
          href={landingHome}
          className="flex items-center gap-2 text-foreground transition-opacity hover:opacity-80"
        >
          <RelayRoomMark className="h-6 w-auto" />
          <span className="text-sm font-semibold tracking-tight">RelayRoom</span>
        </Link>

        {/* center: Docs */}
        <Link
          href={docsHome}
          className={cn(
            "absolute left-1/2 hidden -translate-x-1/2 text-sm font-medium transition-colors sm:block",
            surface === "docs"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {docsLabel}
        </Link>

        {/* right: lang · github · theme · sign in */}
        <div className="flex items-center gap-2 sm:gap-3">
          <SiteLangSwitch locale={locale} surface={surface} />
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {GithubIcon}
          </a>
          <ThemeToggle />
          <SiteNavAuth locale={locale} />
        </div>
      </div>
    </header>
  );
}
