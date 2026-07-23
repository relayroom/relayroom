import { useTranslations } from "next-intl"
import { getTranslations } from "next-intl/server"
import { timeAgoParts } from "@/lib/format"

/**
 * Relative-time formatting, in the caller's locale.
 *
 * `timeAgo` is needed from both server and client components, and next-intl reads
 * translations differently in each (`await getTranslations` vs the `useTranslations`
 * hook). Rather than push that split onto the ~15 call sites, each side gets a
 * one-line wrapper here and every call site keeps writing `timeAgo(iso)`:
 *
 *   server:  const timeAgo = await getTimeAgo()
 *   client:  const timeAgo = useTimeAgo()
 *
 * Both return a plain string, so the values that get interpolated into another
 * message - `t("agentDetail.lastActivity", { time: timeAgo(iso) })` - keep working
 * unchanged.
 *
 * Server and client helpers share one module on purpose. next-intl exports a
 * `react-client` build of `next-intl/server` whose functions throw only when
 * CALLED, so a client component importing `useTimeAgo` from here is safe (and the
 * server entry is tree-shaken out of the client bundle). Do not split this file on
 * the assumption that the import alone breaks the client build - it does not.
 */
export type TimeAgo = (iso: string) => string

/** Server components (async). */
export async function getTimeAgo(): Promise<TimeAgo> {
  const t = await getTranslations("common.time")
  return (iso: string) => {
    const { key, count } = timeAgoParts(iso)
    return t(key, { count })
  }
}

/** Client components. */
export function useTimeAgo(): TimeAgo {
  const t = useTranslations("common.time")
  return (iso: string) => {
    const { key, count } = timeAgoParts(iso)
    return t(key, { count })
  }
}
