/**
 * Spec 15.1 default tunables (phase 12).
 *
 * Estimates before real telemetry; tune after dogfooding. This module is the
 * SINGLE place to change a runtime tunable for the wake-budget feature. Do not
 * inline these numbers anywhere else.
 *
 * NOTE on the DB/runtime split: a few of these (owner wakesPerHour 30 / urgentPerHour 5,
 * the broadcast cap of 8) ALSO appear as column defaults / fallbacks in code that
 * predates this module:
 *   - schema.ts owner_wake_budget defaults (30/5)  -> packages/db/src/schema.ts
 *   - budget.ts DEFAULT_WAKES_PER_HOUR / DEFAULT_URGENT_PER_HOUR (30/5 fallback)
 *   - pipeline.ts effectiveCap min(N, 8), SEND_RATE_PER_MIN 20, IDENTICAL_LIMIT 3
 *   - state.ts WAKE_EXPIRY_MS (10 min), direct-cooldown DIRECT_COOLDOWN_MS (30s)
 *   - detect.ts GOVERNANCE_THRESHOLDS (loopBreaker 3, phantom 5)
 * Those are intentionally NOT refactored to import from here: they are on hot
 * paths / column defaults and each already carries a "spec 15.1" comment. This
 * module is the canonical reference + the source for the project-default helper
 * below; if you change a value here, change the mirror and note it in 00.overview
 * "발견된 이슈".
 */
export const WAKE_DEFAULTS = {
  // owner_wake_budget column defaults (30/5) ALSO live in schema.ts (phase 01) and
  // budget.ts fallbacks. Mirror, do not diverge.
  wakesPerHour: 30,
  urgentPerHour: 5,
  maxBroadcastRecipientsCap: 8, // project default = min(projectPartCount, this)
  loopBreakerSendsPerMinute: 20,
  loopBreakerSamePayloadWindowSec: 60,
  loopBreakerSamePayloadCount: 3,
  projectFloorPercent: 0.2, // reserve floor = max(20% of owner budget, 5/hr)
  projectFloorMin: 5,
  directCooldownSec: 30, // sender->receiver direct wake cooldown
  wakeIntentExpiryMin: 10, // unactivated reserve refund deadline
  detectLoopTripsIn60min: 3, // alert threshold
  detectPhantomTurnsIn60min: 5, // alert threshold
} as const

export type WakeDefaults = typeof WAKE_DEFAULTS

/**
 * The runtime default broadcast cap for a project whose
 * projects.maxBroadcastRecipients column is null: min(partCount, 8). Mirrors the
 * inline computation in pipeline.ts effectiveCap (spec 8, 15.1).
 */
export function projectDefaultMaxRecipients(partCount: number): number {
  return Math.min(partCount, WAKE_DEFAULTS.maxBroadcastRecipientsCap)
}
