/**
 * Regression: absolute timestamps must be stated in the viewer's timezone, and
 * must say which zone that is.
 *
 * The bug being locked out: lib/format.ts added a fixed +9h offset and read the
 * result with UTC getters, so every reader anywhere saw Korean time with nothing
 * on screen to say so. Anything that quietly reintroduces a single hardcoded
 * zone, or drops the label, fails here.
 */
import { describe, expect, it } from "vitest"
import {
  FALLBACK_TIME_ZONE,
  isValidTimeZone,
  makeDateFormatters,
} from "./date-format"

// 2026-07-23T06:41Z is 15:41 in Seoul, 02:41 in New York, 08:41 in Berlin.
const ISO = "2026-07-23T06:41:00.000Z"

describe("makeDateFormatters", () => {
  it("states the instant in the timezone it was given", () => {
    expect(makeDateFormatters("Asia/Seoul").formatDateTime(ISO)).toBe("2026-07-23 15:41 GMT+9")
    expect(makeDateFormatters("UTC").formatDateTime(ISO)).toBe("2026-07-23 06:41 UTC")
    expect(makeDateFormatters("America/New_York").formatDateTime(ISO)).toBe("2026-07-23 02:41 EDT")
    expect(makeDateFormatters("Europe/Berlin").formatDateTime(ISO)).toBe("2026-07-23 08:41 GMT+2")
  })

  it("always names the zone, so a wrong one is at least visible", () => {
    for (const tz of ["Asia/Seoul", "UTC", "Asia/Kolkata"]) {
      expect(makeDateFormatters(tz).formatDateTime(ISO)).toMatch(/ (GMT[+-][\d:]+|[A-Z]{2,5})$/)
    }
  })

  it("keeps one fixed YYYY-MM-DD HH:mm shape regardless of runtime locale", () => {
    expect(makeDateFormatters("Asia/Seoul").formatDateTime(ISO)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /,
    )
    expect(makeDateFormatters("Asia/Seoul").formatDate(ISO)).toBe("2026-07-23")
  })

  it("rolls the date when the zone crosses midnight", () => {
    // 2026-07-23T20:00Z is already the 24th in Seoul, still the 23rd in New York.
    const late = "2026-07-23T20:00:00.000Z"
    expect(makeDateFormatters("Asia/Seoul").formatDate(late)).toBe("2026-07-24")
    expect(makeDateFormatters("America/New_York").formatDate(late)).toBe("2026-07-23")
  })

  it("renders midnight as 00:mm, not 24:mm", () => {
    // 2026-07-22T15:00Z is exactly 00:00 the next day in Seoul.
    expect(makeDateFormatters("Asia/Seoul").formatDateTime("2026-07-22T15:00:00.000Z")).toBe(
      "2026-07-23 00:00 GMT+9",
    )
  })

  it("falls back instead of throwing when the zone is not a real one", () => {
    // The zone comes from a cookie, so a hostile or stale value must not take
    // down every page that renders a timestamp.
    const formatters = makeDateFormatters("Not/AZone")
    expect(formatters.formatDateTime(ISO)).toBe(
      makeDateFormatters(FALLBACK_TIME_ZONE).formatDateTime(ISO),
    )
  })

  it("does not hardcode a single zone for everyone (the original bug)", () => {
    const seoul = makeDateFormatters("Asia/Seoul").formatDateTime(ISO)
    const newYork = makeDateFormatters("America/New_York").formatDateTime(ISO)
    expect(seoul).not.toBe(newYork)
  })
})

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and rejects anything else", () => {
    expect(isValidTimeZone("Asia/Seoul")).toBe(true)
    expect(isValidTimeZone("UTC")).toBe(true)
    expect(isValidTimeZone("Not/AZone")).toBe(false)
    expect(isValidTimeZone("")).toBe(false)
    expect(isValidTimeZone("'; DROP TABLE project; --")).toBe(false)
  })
})
