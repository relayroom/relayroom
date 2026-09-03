"use client"

import { useEffect, useRef } from "react"
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
 *
 * The scroll container has been here since 0.3.0 and does contain the tabs -
 * measured at 375px, the strip overflows by 407px and the page does not scroll.
 * What it did NOT do was show you where you are: the strip always started at
 * scrollLeft 0, so opening Settings on a phone rendered a tab row beginning at
 * Overview with the active tab 400px off-screen, and nothing on screen said the
 * row could be scrolled at all. Containing the overflow and revealing the active
 * tab are two different jobs, and only the first one was done.
 */
export function TabBar({ tabs, ariaLabel }: Props) {
  const pathname = usePathname()
  const stripRef = useRef<HTMLDivElement>(null)

  // Bring the active tab into view whenever the route changes.
  //
  // Sets `scrollLeft` rather than calling `scrollIntoView`, which walks up and
  // scrolls every scrollable ancestor including the document - on a page already
  // scrolled down, that yanks the view. This touches one element and cannot move
  // anything else.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const active = strip.querySelector<HTMLElement>('[aria-current="page"]')
    if (!active) return
    if (strip.scrollWidth <= strip.clientWidth) return

    // Offsets within the strip's own scroll box, so an ancestor's position (the
    // sticky header, the page scroll) never enters the arithmetic.
    const left = active.offsetLeft
    const right = left + active.offsetWidth
    const viewLeft = strip.scrollLeft
    const viewRight = viewLeft + strip.clientWidth
    // A margin so the active tab does not sit flush against the edge, where it
    // reads as clipped rather than as the end of the row.
    const margin = 24
    if (left < viewLeft + margin) strip.scrollLeft = Math.max(0, left - margin)
    else if (right > viewRight - margin) strip.scrollLeft = right - strip.clientWidth + margin
  }, [pathname, tabs])

  const isActive = (tab: TabItem): boolean => {
    const hit = (p: string, exact?: boolean) =>
      exact ? pathname === p : pathname === p || pathname.startsWith(`${p}/`)
    if (hit(tab.href, tab.exact)) return true
    return (tab.aliases ?? []).some((a) => pathname === a)
  }

  return (
    <div ref={stripRef} className="overflow-x-auto scrollbar-hide">
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
