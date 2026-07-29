import type { WakeSuppressionReason } from "@/modules/wake/queries"

/**
 * The i18n key for a persisted suppression reason.
 *
 * Exhaustive over the persisted vocabulary, and the `never` check earns its keep
 * only because `WakeSuppressionReason` is derived from the column rather than
 * written out by hand: a fifth reason added to the schema widens the union, this
 * switch stops being exhaustive, and the build fails here instead of rendering the
 * raw string to an operator. Against a hand-kept list the same check would pass
 * happily while the new value arrived at runtime - the guarantee would be in the
 * comment and nowhere else, which is the failure this whole area keeps producing.
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
