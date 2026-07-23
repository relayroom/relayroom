/**
 * Relative time, in the reader's language.
 *
 * `timeAgo` used to return Korean literals ("방금 전", "3분 전") regardless of
 * locale, so an `en` reader saw Korean in every list, card, and agent detail
 * page. The strings moved to `common.time`; these tests hold both halves of that:
 *
 *   - the thresholds are unchanged, so nothing about WHICH unit is chosen moved
 *     when the strings did (this is why Intl.RelativeTimeFormat was not used -
 *     its `numeric: "auto"` renders -2 days as "그저께", and its automatic unit
 *     selection folds long gaps into weeks and years, while these thresholds
 *     have no upper bound);
 *   - the ICU messages render correctly in BOTH locales, including English
 *     plurals, which Korean does not have and so cannot catch.
 *
 * Rendering goes through the real message files. A mistyped key would otherwise
 * pass silently: next-intl returns the key itself when it cannot resolve one, so
 * a reader would see "minutes" instead of "3분 전".
 */
import { describe, expect, it } from "vitest"
import { createTranslator } from "next-intl"
import en from "@/messages/en/common.json"
import ko from "@/messages/ko/common.json"
import { timeAgoParts } from "@/lib/format"

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString()

/** The same composition lib/time-ago.ts performs, against the real messages. */
function render(locale: "en" | "ko", iso: string): string {
  const t = createTranslator({
    locale,
    messages: { common: locale === "en" ? en : ko },
    namespace: "common.time",
  })
  const { key, count } = timeAgoParts(iso)
  return t(key, { count })
}

describe("timeAgoParts", () => {
  it("keeps the original thresholds", () => {
    expect(timeAgoParts(agoIso(0))).toEqual({ key: "justNow", count: 0 })
    expect(timeAgoParts(agoIso(59 * SEC))).toEqual({ key: "justNow", count: 0 })
    expect(timeAgoParts(agoIso(60 * SEC))).toEqual({ key: "minutes", count: 1 })
    expect(timeAgoParts(agoIso(59 * MIN))).toEqual({ key: "minutes", count: 59 })
    expect(timeAgoParts(agoIso(60 * MIN))).toEqual({ key: "hours", count: 1 })
    expect(timeAgoParts(agoIso(23 * HOUR))).toEqual({ key: "hours", count: 23 })
    expect(timeAgoParts(agoIso(24 * HOUR))).toEqual({ key: "days", count: 1 })
  })

  it("has no upper bound - a long gap stays in days", () => {
    // Intl's automatic unit selection would say "1 year ago" here. The existing
    // behaviour counts days indefinitely, and this change did not alter that.
    expect(timeAgoParts(agoIso(400 * DAY))).toEqual({ key: "days", count: 400 })
  })
})

describe("rendered output", () => {
  it("is unchanged in Korean", () => {
    expect(render("ko", agoIso(10 * SEC))).toBe("방금 전")
    expect(render("ko", agoIso(3 * MIN))).toBe("3분 전")
    expect(render("ko", agoIso(5 * HOUR))).toBe("5시간 전")
    expect(render("ko", agoIso(2 * DAY))).toBe("2일 전")
    // Not "그저께", which is what Intl's numeric:"auto" produces for -2 days.
    expect(render("ko", agoIso(2 * DAY))).not.toBe("그저께")
  })

  it("is English for an English reader", () => {
    expect(render("en", agoIso(10 * SEC))).toBe("just now")
    expect(render("en", agoIso(3 * MIN))).toBe("3 minutes ago")
    expect(render("en", agoIso(5 * HOUR))).toBe("5 hours ago")
    expect(render("en", agoIso(2 * DAY))).toBe("2 days ago")
  })

  it("pluralizes English singulars", () => {
    expect(render("en", agoIso(1 * MIN))).toBe("1 minute ago")
    expect(render("en", agoIso(1 * HOUR))).toBe("1 hour ago")
    expect(render("en", agoIso(1 * DAY))).toBe("1 day ago")
  })

  it("renders no Korean for an English reader", () => {
    for (const ms of [10 * SEC, MIN, 3 * MIN, HOUR, 5 * HOUR, DAY, 2 * DAY, 400 * DAY]) {
      expect(render("en", agoIso(ms))).not.toMatch(/[가-힣]/)
    }
  })

  it("resolves every key in both locales", () => {
    // next-intl echoes an unresolved key back, so a typo would render as the key.
    for (const ms of [10 * SEC, 3 * MIN, 5 * HOUR, 2 * DAY]) {
      for (const locale of ["en", "ko"] as const) {
        const { key } = timeAgoParts(agoIso(ms))
        expect(render(locale, agoIso(ms))).not.toBe(key)
      }
    }
  })
})
