/**
 * Absolute date/time formatting, in the viewer's timezone.
 *
 * Client-safe: no next/headers, no fs. The server-side reader that resolves the
 * viewer's timezone from the request lives in lib/date-format.server.ts.
 *
 * WHY A TIMEZONE HAS TO BE PASSED IN
 *
 * These values are rendered by server components, so the process has no idea
 * where the reader is. The previous code answered that by adding a fixed +9h
 * offset and formatting in UTC - every user in the world read Korean time. The
 * comment explaining it cited hydration mismatches, which is a real hazard but
 * not one server components have: a server component renders once on the server
 * and the browser never recomputes its text. The hazard belongs to client
 * components, which render the same value twice (SSR, then hydration) and see a
 * different clock each time. So the fix is not to render on the client - that
 * would create the very mismatch the old comment feared - but to tell the server
 * which zone to format for. See lib/date-format.server.ts for how it learns.
 *
 * WHY THE OUTPUT IS NOT LOCALE-FORMATTED
 *
 * The shape is fixed as YYYY-MM-DD, independent of locale. Two reasons. It is
 * what this app already showed, in a mono font, next to ids and token counts -
 * these read as technical timestamps, not prose. And the sites being replaced
 * called toLocaleDateString() with no arguments, which follows the *runtime's*
 * default locale: server-rendered ones were formatted with whatever locale the
 * container happened to have, never the reader's. Pinning the shape removes
 * that nondeterminism outright rather than trading it for another source of it.
 */

/** Cookie holding the viewer's IANA timezone. Not a next-intl convention, hence the app prefix. */
export const TIME_ZONE_COOKIE = "rr_tz"

/** Used until the viewer's real zone is known. Labelled on screen, never silent. */
export const FALLBACK_TIME_ZONE = "UTC"

/**
 * Whether a string names a timezone this runtime can format in.
 *
 * The value arrives from a cookie, so it is user-controlled: Intl throws a
 * RangeError on an unknown zone, which would turn an edited cookie into a
 * server-rendering crash on every page showing a timestamp.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone })
    return true
  } catch {
    return false
  }
}

export interface DateFormatters {
  /** `2026-07-23 15:41 GMT+9` - date, time, and the zone it is stated in. */
  formatDateTime: (iso: string) => string
  /** `2026-07-23` - no zone label; see the note in makeDateFormatters. */
  formatDate: (iso: string) => string
}

/** Pull the named pieces out so assembly cannot be reordered by a locale. */
function partsOf(
  date: Date,
  timeZone: string,
  withZoneName: boolean,
): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(withZoneName ? { timeZoneName: "short" as const } : {}),
  })
  const out: Record<string, string> = {}
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value
  return out
}

/**
 * Formatters bound to one timezone.
 *
 * formatDateTime carries the zone; formatDate does not. A labelled bare date
 * ("2026-07-23 GMT+9") is mostly noise - the label doubles the width of a table
 * cell to qualify a value already too coarse for the zone to usually matter.
 * A timestamp is the opposite: it is precise enough that the zone is part of the
 * value, and it is what someone lines up against an agent's log.
 */
export function makeDateFormatters(timeZone: string): DateFormatters {
  const zone = isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIME_ZONE

  return {
    formatDateTime(iso: string): string {
      const p = partsOf(new Date(iso), zone, true)
      // hour is "24" at midnight under hour12:false in some runtimes; normalize.
      const hour = p.hour === "24" ? "00" : p.hour
      return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute} ${p.timeZoneName}`
    },
    formatDate(iso: string): string {
      const p = partsOf(new Date(iso), zone, false)
      return `${p.year}-${p.month}-${p.day}`
    },
  }
}
