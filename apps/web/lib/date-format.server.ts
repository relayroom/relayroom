import "server-only"

import { cookies } from "next/headers"
import { cache } from "react"
import {
  FALLBACK_TIME_ZONE,
  TIME_ZONE_COOKIE,
  isValidTimeZone,
  makeDateFormatters,
  type DateFormatters,
} from "./date-format"

/**
 * The viewer's timezone, as told to us by their browser.
 *
 * A request does not carry the reader's timezone, so it has to be stored, the
 * same way the reader's language already is: components/timezone-sync.tsx writes
 * the browser's IANA zone to a cookie once, and this reads it back. Keeping the
 * decision in a cookie is what lets timestamps stay SERVER-rendered - the reason
 * that matters is in lib/date-format.ts.
 *
 * Falls back to UTC when the cookie is absent (a first visit, or cookies off) or
 * holds something Intl will not accept. The fallback is not silent: every
 * timestamp names the zone it is stated in, so a reader seeing UTC can tell that
 * is what they are looking at rather than quietly reading the wrong hour.
 */
export const getDisplayTimeZone = cache(async (): Promise<string> => {
  const raw = (await cookies()).get(TIME_ZONE_COOKIE)?.value
  return raw && isValidTimeZone(raw) ? raw : FALLBACK_TIME_ZONE
})

/**
 * Date formatters for the current request, in the viewer's timezone.
 *
 *   const { formatDateTime } = await getDateFormatters()
 *
 * Mirrors getTimeAgo() in lib/time-ago.ts: call sites keep writing
 * `formatDateTime(iso)` and gain one line at the top of the component.
 */
export async function getDateFormatters(): Promise<DateFormatters> {
  return makeDateFormatters(await getDisplayTimeZone())
}
