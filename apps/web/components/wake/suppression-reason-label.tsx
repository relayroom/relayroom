import type { WakeSuppressionReason } from "@/modules/wake/queries"

/**
 * The i18n key for a persisted suppression reason.
 *
 * Exhaustive over the persisted vocabulary, and the `never` check is the point: if
 * a fifth reason is added server-side, this stops compiling instead of quietly
 * rendering the raw string or an empty label. That is the failure this whole area
 * has produced repeatedly - a list of reasons drifting away from the writers that
 * produce them - so it is worth spending a type on.
 *
 * `null` is not "unknown reason we should look into". It is a suppression recorded
 * before the writers stamped one, and it is labelled as not recorded rather than
 * guessed at, because inferring a reason from its absence is exactly how the
 * missing `direct_cooldown` stayed invisible.
 */
export function suppressionReasonKey(reason: WakeSuppressionReason | null): string {
  switch (reason) {
    case "budget_exhausted":
      return "audit.reasonBudgetExhausted"
    case "limited":
      return "audit.reasonLimited"
    case "loop_breaker":
      return "audit.reasonLoopBreaker"
    case "direct_cooldown":
      return "audit.reasonDirectCooldown"
    case null:
      return "audit.reasonUnknown"
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}
