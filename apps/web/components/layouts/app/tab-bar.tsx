"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

export interface TabItem {
  label: string
  href: string
  /** Exact path match instead of the default startsWith (for index tabs). */
  exact?: boolean
  /** Extra pathnames (exact match) that also mark this tab active, e.g. an
   * index alias like "/settings" mapping to the profile tab. */
  aliases?: string[]
}

interface Props {
  tabs: TabItem[]
  ariaLabel?: string
}

/**
 * Single dashboard tab bar. Give it a tabs array; it renders the links, marks
 * the active one from the current pathname, and is horizontally scrollable
 * (touch swipe / shift+wheel) with no visible scrollbar so overflow tabs never
 * add a page-level horizontal scroll on mobile.
 */
export function TabBar({ tabs, ariaLabel }: Props) {
  const pathname = usePathname()

  const isActive = (tab: TabItem): boolean => {
    const hit = (p: string, exact?: boolean) =>
      exact ? pathname === p : pathname === p || pathname.startsWith(`${p}/`)
    if (hit(tab.href, tab.exact)) return true
    return (tab.aliases ?? []).some((a) => pathname === a)
  }

  return (
    <div className="overflow-x-auto scrollbar-hide">
      <nav className="flex gap-0 -mb-px" aria-label={ariaLabel}>
        {tabs.map((tab) => {
          const active = isActive(tab)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
