"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Sticky project tab header that shows an elevation shadow ONLY once content has
 * scrolled underneath it. Uses an IntersectionObserver on a zero-height sentinel
 * placed at the header's natural top - the callback fires just twice (on cross),
 * never per scroll frame, so there is no scroll-handler cost.
 *
 * The sticky offset is top-14 (56px, under the global topbar); the matching
 * `rootMargin` makes the sentinel "leave" exactly when the header pins.
 */
export function StickyTabHeader({ children }: { children: ReactNode }) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting),
      // Detection line at the global topbar's bottom (h-14 = 56px). The 1px
      // sentinel overlaps it at scroll-top (intersecting → no shadow) and clears
      // it once the page scrolls (not intersecting → shadow).
      { rootMargin: "-56px 0px 0px 0px", threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <div ref={sentinelRef} aria-hidden className="h-px" />
      <div
        className={cn(
          "sticky top-14 z-20 border-b border-border bg-background transition-shadow duration-200",
          stuck ? "shadow-[0_8px_16px_-8px_rgb(0_0_0/0.22)]" : "shadow-none",
        )}
      >
        <div className="mx-auto max-w-6xl px-6 pt-5 pb-0">{children}</div>
      </div>
    </>
  )
}
