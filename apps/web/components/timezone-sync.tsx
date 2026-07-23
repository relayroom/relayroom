"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { TIME_ZONE_COOKIE, isValidTimeZone } from "@/lib/date-format"

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

function readCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`),
  )
  return match ? decodeURIComponent(match[1]!) : null
}

/**
 * Tells the server which timezone to render timestamps in.
 *
 * Server components have no way to know where the reader is, so absolute
 * timestamps used to be rendered in a hardcoded zone (see lib/date-format.ts).
 * This reports the browser's zone once, into a cookie the server reads on the
 * next render - the same shape as the NEXT_LOCALE cookie that already decides
 * the reader's language, so display context comes from one place instead of
 * each timestamp inventing its own answer.
 *
 * Writes only when the stored value actually differs from the browser's, and
 * only then refreshes. Refreshing unconditionally would loop: refresh renders
 * this component again, which would refresh again.
 *
 * Not a Server Action: it carries no user intent to validate and needs no
 * revalidatePath, so a document.cookie write plus one refresh is the whole job.
 * The value is not a secret and the server re-validates it through Intl anyway,
 * so a reader-writable cookie is fine - the worst an edited one can do is show
 * that reader their own timestamps in a zone they chose.
 */
export function TimezoneSync() {
  const router = useRouter()

  useEffect(() => {
    let zone: string
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return
    }
    if (!zone || !isValidTimeZone(zone)) return
    if (readCookie(TIME_ZONE_COOKIE) === zone) return

    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`
    // Re-render the server tree so timestamps already on screen switch zone
    // instead of waiting for the next navigation.
    router.refresh()
  }, [router])

  return null
}
