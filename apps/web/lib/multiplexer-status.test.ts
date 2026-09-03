/**
 * What the part card is allowed to claim about a part's delivery.
 *
 * The cases worth pinning are the ones where a wrong answer looks like a right one:
 * a part nobody has measured must not read as tmux, and a part whose wakes are going
 * nowhere must not read like a part that is simply idle. Both of those render as a
 * perfectly ordinary row if the derivation is careless, and neither would be noticed
 * by using the dashboard.
 */
import { describe, expect, it } from "vitest"
import { deriveMultiplexer, isDeliveryStalled, WAKE_STALL_MS } from "./multiplexer-status"

describe("deriveMultiplexer", () => {
  it("reports the multiplexer when intent and measurement agree", () => {
    expect(deriveMultiplexer("tmux", "tmux")).toEqual({ kind: "match", via: "tmux" })
    expect(deriveMultiplexer("herdr", "herdr")).toEqual({ kind: "match", via: "herdr" })
  })

  it("reports a fallback as degraded, naming both halves", () => {
    // The one state the two columns exist to represent. A single column could not
    // hold it, which is why the server sends two.
    expect(deriveMultiplexer("herdr", "tmux")).toEqual({
      kind: "degraded",
      intent: "herdr",
      via: "tmux",
    })
  })

  it("does not call an unmeasured part tmux", () => {
    // The whole reason null is not defaulted. Every pager older than this field
    // sends neither value, so a tmux default would put a confident badge on every
    // part on the previous release - a reading invented from silence.
    expect(deriveMultiplexer(null, null)).toEqual({ kind: "unreported" })
    expect(deriveMultiplexer("herdr", null)).toEqual({ kind: "unreported" })
    expect(deriveMultiplexer(undefined, undefined)).toEqual({ kind: "unreported" })
  })

  it("treats a multiplexer it does not know as unmeasured", () => {
    // A newer CLI reporting a third backend must read as "this screen cannot say",
    // never as one of the two names this screen happens to know.
    expect(deriveMultiplexer("tmux", "screen")).toEqual({ kind: "unreported" })
    expect(deriveMultiplexer("zellij", "herdr")).toEqual({ kind: "match", via: "herdr" })
  })

  it("reports what is delivering when only the intent is missing", () => {
    // Half a measurement is still a measurement, and claiming a disagreement we
    // cannot see would be worse than reporting the half we have.
    expect(deriveMultiplexer(null, "herdr")).toEqual({ kind: "match", via: "herdr" })
  })
})

describe("isDeliveryStalled", () => {
  const now = new Date("2026-08-19T12:00:00Z")
  const ago = (ms: number) => new Date(now.getTime() - ms)

  it("reports a wake that was taken and never delivered", () => {
    expect(
      isDeliveryStalled({ pagerOnline: true, stalledWakeSince: ago(WAKE_STALL_MS + 1000), now }),
    ).toBe(true)
  })

  it("does not report a wake that is merely recent", () => {
    // The pager retries. Calling a busy TUI broken would train people to ignore
    // this badge, which costs more than the case it was added for.
    expect(
      isDeliveryStalled({ pagerOnline: true, stalledWakeSince: ago(WAKE_STALL_MS - 1000), now }),
    ).toBe(false)
  })

  it("says nothing when no wake has ever been queued", () => {
    // False here means "no stuck wake is on record", NOT "delivery works". A part
    // nothing has been sent to is indistinguishable from a healthy one, and this
    // function must not resolve that by guessing - which is why the badge draws no
    // green for it either.
    expect(isDeliveryStalled({ pagerOnline: true, stalledWakeSince: null, now })).toBe(false)
  })

  it("stays quiet while the pager itself is down", () => {
    // A dead pager delivers nothing either, and the screen already says the pager is
    // dead. Reporting it twice in different words makes one fault look like two.
    expect(
      isDeliveryStalled({ pagerOnline: false, stalledWakeSince: ago(WAKE_STALL_MS * 10), now }),
    ).toBe(false)
  })
})
